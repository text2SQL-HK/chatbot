#region import
from __future__ import annotations

import copy
import csv
import io
import json
import os
import re
import tarfile
import time
import oracledb
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple, TypedDict, Union

import docker
import httpx
import oracledb
from tabulate import tabulate
from threading import Lock
import base64
import re

from openai import OpenAI
from langchain_core.documents import Document
from langchain_core.output_parsers import JsonOutputParser, StrOutputParser
from langchain_core.prompts import ChatPromptTemplate
from langchain_core.pydantic_v1 import BaseModel, Field
from langchain_core.runnables import RunnableLambda
from langchain_openai import ChatOpenAI
from langgraph.graph import END, START, StateGraph
from langchain_community.retrievers import BM25Retriever
from langchain.retrievers import EnsembleRetriever
from langchain_community.vectorstores import FAISS
from langchain_openai import OpenAIEmbeddings
from langchain_community.document_loaders import JSONLoader, TextLoader
from neo4j import GraphDatabase
import numpy as np
from openai import OpenAI

#endregion
# --- 경로/환경 설정 -------------------------------------------------------------------
try:
    from ..config import PROMPT_DIR, BASE_DIR, APP_DIR, PLOT_IMAGE_NAME, PLOT_TMP_DIR, ORACLE_JSON_PATH
    from ..tools.tools import TOOLS, plot, execute_python, text_to_sql
except ImportError:
    try:
        from tts_chatbot.app.config import PROMPT_DIR, BASE_DIR, APP_DIR, PLOT_IMAGE_NAME, PLOT_TMP_DIR, ORACLE_JSON_PATH
        from tts_chatbot.app.tools.tools import TOOLS, plot, execute_python, text_to_sql
    except ImportError:
        import sys

        _app_dir = Path(__file__).resolve().parents[1]
        if str(_app_dir) not in sys.path:
            sys.path.insert(0, str(_app_dir))
        from config import PROMPT_DIR, BASE_DIR, APP_DIR, PLOT_IMAGE_NAME, PLOT_TMP_DIR, ORACLE_JSON_PATH
        from tools.tools import TOOLS, plot, execute_python, text_to_sql

#API key 입력 혹은 환경변수로 설정해주셔야 합니다
# Configure OPENAI_API_KEY in the process environment.

OPENAI_CLIENT = OpenAI()
RESPONSES_MODEL = os.environ.get("CHATBOT_RESPONSES_MODEL", "gpt-5.2")

with open(ORACLE_JSON_PATH, "r", encoding="utf-8") as f:
    ORACLE_JSON = json.load(f)

SQL_EXEC_TRACK_URL = os.environ.get("SQL_EXEC_TRACK_URL", "http://127.0.0.1:1234/ui/sql_exec")
# --- 프롬프트 로더 --------------------------------------------------------------------
def load_prompt(path: Path) -> str:
    if not path.exists():
        raise FileNotFoundError(f"Prompt file not found: {path}")
    return path.read_text(encoding="utf-8")

CHATBOT_SYS_PROMPT = load_prompt(PROMPT_DIR / "SYS_PROMPT-mod.txt")
# --- 유틸리티 -------------------------------------------------------------------------
def evidence_maker(questions: List[str], answers: List[str]) -> str:
    if len(questions) != len(answers):
        raise ValueError("Number of questions and answers does not match.")
    lines: List[str] = []
    for idx, question in enumerate(questions, start=1):
        lines.append(f"Q{idx}. {question}\n")
        lines.append(f"A. {answers[idx - 1]}\n")
    return "".join(lines)

def is_safe_query(sql: str) -> bool:
    """
    Oracle DB용: 데이터 손상 위험이 있는 쿼리를 제외.
    허용: SELECT, WITH, EXPLAIN PLAN
    차단: INSERT, UPDATE, DELETE, MERGE, DROP, ALTER, TRUNCATE, CREATE 등
    """
    sql_upper = sql.strip().upper()

    # 허용된 쿼리만 통과
    safe_prefixes = ("SELECT", "WITH", "EXPLAIN PLAN")
    forbidden_patterns = [
        r"\bINSERT\b",
        r"\bUPDATE\b",
        r"\bDELETE\b",
        r"\bMERGE\b",
        r"\bDROP\b",
        r"\bALTER\b",
        r"\bTRUNCATE\b",
        r"\bCREATE\b",
        r"\bGRANT\b",
        r"\bREVOKE\b",
        r"\bEXECUTE\b",
        r"\bCALL\b",
        r"\bBEGIN\b"
    ]
    if any(re.search(pat, sql_upper) for pat in forbidden_patterns):
        return False
    return True

def table_info_maker(rows, cols) -> str:
    if not rows:
        return "#Table\n[]"
    col_types = []
    first_row = rows[0]
    for value in first_row:
        col_types.append(type(value).__name__)
    result_lines = ["#Table\n["]
    for idx, col in enumerate(cols):
        dtype = col_types[idx] if idx < len(col_types) else "unknown"
        result_lines.append(f" ({col}, type: {dtype})\n")
    result_lines.append("]")
    return "".join(result_lines)

def _record_sql_execution(user_id: str) -> None:
    if not user_id:
        return
    endpoint = SQL_EXEC_TRACK_URL.strip()
    if not endpoint:
        return
    payload = {"user_id": user_id}
    try:
        with httpx.Client(timeout=2.0) as client:
            client.post(endpoint, json=payload)
    except httpx.HTTPError as exc:
        print(f"[sql_exec_num] update failed: {exc}", flush=True)


def _safe_parse_json(text: Any) -> Optional[Any]:
    if not text or not isinstance(text, (str, bytes, bytearray)):
        return None
    if isinstance(text, (bytes, bytearray)):
        try:
            text = text.decode("utf-8")
        except Exception:
            return None
    try:
        return json.loads(text)
    except Exception:
        return None


def _extract_response_payload(response) -> Tuple[str, List[Dict[str, Any]]]:
    texts: List[str] = []
    mcp_calls: List[Dict[str, Any]] = []
    for item in getattr(response, "output", []):
        item_type = getattr(item, "type", "")
        if item_type == "message":
            for block in getattr(item, "content", []):
                text = getattr(block, "text", None)
                if text:
                    texts.append(text)
        elif item_type == "mcp_call":
            call_payload: Dict[str, Any] = {
                "id": getattr(item, "id", ""),
                "name": getattr(item, "name", ""),
                "arguments": getattr(item, "arguments", ""),
                "output": getattr(item, "output", None),
                "error": getattr(item, "error", None),
            }
            parsed_output = _safe_parse_json(call_payload["output"])
            if isinstance(parsed_output, dict):
                call_payload["output_data"] = parsed_output
            mcp_calls.append(call_payload)
    return "\n".join(texts), mcp_calls

def _ensure_plot_container(client: docker.DockerClient, user_id: str):
    try:
        container = client.containers.get(user_id)
        container.reload()
        if container.status != "running":
            container.start()
    except docker.errors.NotFound:
        container = client.containers.run(
            PLOT_IMAGE_NAME,
            command="sleep infinity",
            detach=True,
            name=user_id,
        )
    return container

def _allocate_csv_path(container) -> Tuple[str, str]:
    list_command = f"ls {PLOT_TMP_DIR}/output*.csv 2>/dev/null || true"
    _, output = container.exec_run(["/bin/sh", "-c", list_command])
    decoded = output.decode("utf-8") if isinstance(output, (bytes, bytearray)) else str(output)
    indices = [int(match) for match in re.findall(r"output(\d+)\.csv", decoded)]
    next_index = max(indices) + 1 if indices else 1
    filename = f"output{next_index}.csv"
    return filename, f"{PLOT_TMP_DIR}/{filename}"

def run_sql(
    sql: str,
    db_id: str,
    user_id: str,
    save_csv: bool = True
) -> Dict[str, Any]:
    """
    sql 가져와서 실행하고 컨테이너 생성 후 그 안에 저장하는 함수.
    """
    user = ORACLE_JSON[db_id]["ORACLE_USER"]
    host = ORACLE_JSON[db_id]["ORACLE_HOST"]
    port = ORACLE_JSON[db_id]["ORACLE_PORT"]
    service_name = ORACLE_JSON[db_id]["ORACLE_SERVICE_NAME"]
    password = ORACLE_JSON[db_id]["ORACLE_PASSWORD"]
    if not is_safe_query(sql):
        print("Not Safe!")
    oracledb.init_oracle_client(lib_dir=os.environ.get("ORACLE_CLIENT_LIB_DIR") or None)
    try: conn = oracledb.connect(user=user, password = password, dsn=f"{host}:{port}/{service_name}")
    except:
        print("error")
        exit
    with conn.cursor() as cur:
        cur.execute(sql)
        rows = cur.fetchall()
        cols = [d[0] for d in cur.description]
    if not save_csv:
        table_info = table_info_maker(rows, cols)
        serializable_rows = [["" if cell is None else str(cell) for cell in row] for row in rows]
        return {
            "table_info": table_info,
            "headers": [str(col) for col in cols],
            "rows": serializable_rows,
        }
    #csv 생성
    buffer = io.StringIO()
    writer = csv.writer(buffer)
    writer.writerow(cols)
    writer.writerows(rows)
    csv_text = buffer.getvalue()
    #container 생성 및 파일 경로 결정
    client = docker.from_env()
    container = _ensure_plot_container(client, user_id)
    dest_filename, dest_path_in_container = _allocate_csv_path(container)
    pw_tarstream = io.BytesIO()
    encoded_csv = csv_text.encode("utf-8")
    with tarfile.open(fileobj=pw_tarstream, mode="w") as tar:
        tarinfo = tarfile.TarInfo(name=dest_filename)
        tarinfo.size = len(encoded_csv)
        tar.addfile(tarinfo, io.BytesIO(encoded_csv))
    pw_tarstream.seek(0)
    dest_dir = os.path.dirname(dest_path_in_container)
    container.put_archive(path=dest_dir, data=pw_tarstream.getvalue())
    verify_command = f"cat {dest_path_in_container}"
    exit_code, output = container.exec_run(verify_command)
    if exit_code == 0:
        print(output.decode().strip())
        print(f"CSV saved to {dest_path_in_container}")
    else:
        print("Error verifying file:")
        print(output.decode().strip())

    table_info = table_info_maker(rows, cols)
    serializable_rows = [["" if cell is None else str(cell) for cell in row] for row in rows]

    _record_sql_execution(user_id)

    return {
        "table_info": table_info,
        "csv": csv_text,
        "headers": [str(col) for col in cols],
        "rows": serializable_rows,
        "csv_path": dest_path_in_container,
    }

def test_sql(
    sql: str,
    db_id: str,
    user_id: str
) -> Dict[str, Any]:
    """
    SQL 실행 테스트 함수. 오직 10개의 행만 반환.
    """
    new_sql = f"{sql} FETCH FIRST 10 ROWS ONLY"
    return run_sql(new_sql, db_id, user_id, save_csv=False)

def format_docs(docs: List[Document]) -> str:
    """
    Document 객체 리스트의 page_content를
    하나의 문자열로 합칩니다.
    """
    return "\n\n".join(doc.page_content for doc in docs)

def run_chat_turn(
    user_prompt: str,
    chat_history: List[Dict[str, str]],
    user_id: str
) -> Dict[str, Any]:
    chat_history.append({"role": "user", "content": user_prompt})
    sanitized_history: List[Dict[str, str]] = []
    for entry in chat_history:
        if entry.get("type", "") != "":
            continue
        role = entry.get("role")
        if role is None:
            continue
        content = entry.get("content")
        sanitized_entry: Dict[str, str] = {
            "role": str(role),
            "content": str(content) if content is not None else "",
        }
        sanitized_history.append(sanitized_entry)
    for chat in sanitized_history:
        if chat["role"] != "system":
            print(chat)
    start = time.time()
    response = OPENAI_CLIENT.responses.create(
        model=RESPONSES_MODEL,
        input=sanitized_history,
        tools=TOOLS,
        reasoning={"effort": "medium"}
    )
    sanitized_history += response.output
    print(sanitized_history)
    for item in response.output:
        if item.type == "function_call":
            args = json.loads(item.arguments)
            if item.name == "plot":
                plot_result = plot(**args)
                sanitized_history.append({
                    "type": "function_call_output",
                    "call_id": item.call_id,
                    "output": json.dumps({
                        "plot": plot_result
                    })  
                })
            elif item.name == "execute_python":
                execute_result = execute_python(**args)
                sanitized_history.append({
                    "type": "function_call_output",
                    "call_id": item.call_id,
                    "output": json.dumps({
                        "execute_python": execute_result
                    })
                })
            elif item.name == "text_to_sql":
                text_to_sql_result = text_to_sql(**args)
                sanitized_history.append({
                    "type": "function_call_output",
                    "call_id": item.call_id,
                    "output": json.dumps({
                        "text_to_sql": text_to_sql_result
                    })
                })
    response = OPENAI_CLIENT.responses.create(
        model = RESPONSES_MODEL,
        input = sanitized_history,
        tools = TOOLS,
        reasoning = {"effort": "medium"}
    )
    elapsed = time.time() - start
    print(f"API took {elapsed:.4f} seconds")
    assistant_reply, _ = _extract_response_payload(response)
    assistant_reply = assistant_reply.strip()

    if assistant_reply:
        chat_history.append({"role": "assistant", "content": assistant_reply})
        print(chat_history)

    if assistant_reply.startswith("**PLOT**"):
        docker_client = docker.from_env()
        container = _ensure_plot_container(docker_client, user_id)
        try: stream, stat = container.get_archive(f"{PLOT_TMP_DIR}/output.png")
        except: exit()
        file_like = io.BytesIO(b"".join(stream))
        with tarfile.open(fileobj=file_like) as tar:
            member = tar.getmembers()[0]
            file_data = tar.extractfile(member).read()
        b64_encoded = base64.b64encode(file_data).decode("utf-8")
        b64_encoded = f"data:image/png;base64,{b64_encoded}"
        return {
            "response": assistant_reply,
            "chat_history": chat_history,
            "image": b64_encoded
        }

    return {
        "response": assistant_reply,
        "chat_history": chat_history,
    }