from __future__ import annotations

import importlib.util
import sys
import docker
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional, TypedDict
import httpx
import json
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

BASE_DIR = Path(__file__).resolve().parent
ROOT_DIR = BASE_DIR.parents[1]
STATIC_DIR = BASE_DIR / "static"
PIPELINE_PATH = BASE_DIR / "services" / "backend.py"
MCP_CONTEXT_URL = "https://wdhdh3.ngrok.io/ui/context"
MCP_DB_URL = "http://127.0.0.1:1234/ui/db"
DB_LIST_PATH = BASE_DIR / "metadata" / "db_list.json"

_spec = importlib.util.spec_from_file_location("tts_text_to_sql", PIPELINE_PATH)
if _spec is None or _spec.loader is None:
    raise RuntimeError(f"Unable to load pipeline module from {PIPELINE_PATH}")
_pipeline = importlib.util.module_from_spec(_spec)
sys.modules[_spec.name] = _pipeline
_spec.loader.exec_module(_pipeline)

run_chat_turn = getattr(_pipeline, "run_chat_turn")
CHATBOT_SYS_PROMPT = getattr(_pipeline, "CHATBOT_SYS_PROMPT")
run_sql = getattr(_pipeline, "run_sql")
run_promode = getattr(_pipeline, "run_promode", None)
evidence_maker = getattr(_pipeline, "evidence_maker", None)
PLOT_IMAGE_NAME = getattr(_pipeline, "PLOT_IMAGE_NAME")

DB_LIST = []
with open(DB_LIST_PATH, "r", encoding="utf-8") as f:
    loaded = json.load(f)
tables_data = loaded if isinstance(loaded, list) else [loaded]

for table_data in tables_data:
    DB_LIST.append(table_data["db_id"])

class PipelineInput(BaseModel):
    user_id: str
    message: str
    mode: Optional[str] = "chat"


class PipelineOutput(BaseModel):
    response: str
    history: Optional[List[Dict[str, Any]]] = None
    pending_job: Optional[Dict[str, Any]] = None


class FollowUpInput(BaseModel):
    user_id: str
    message: str


class FollowUpOutput(BaseModel):
    response: str
    history: Optional[List[Dict[str, Any]]] = None
    img: str
    pending_job: Optional[Dict[str, Any]] = None

class SqlExecuteInput(BaseModel):
    user_id: str
    sql: str


class SqlExecuteOutput(BaseModel):
    message: str
    headers: Optional[List[str]] = None
    rows: Optional[List[List[str]]] = None
    table_info: Optional[str] = None
    csv: Optional[str] = None
    csv_path: Optional[str] = None
    table_number: Optional[int] = None
    has_more: Optional[bool] = None
    history: Optional[List[Dict[str, Any]]] = None


class SqlJobFinalizeInput(BaseModel):
    user_id: str
    job_id: str


class SqlJobFinalizeOutput(BaseModel):
    status: str
    message: str
    history: List[Dict[str, Any]]


class SqlTableMoreInput(BaseModel):
    user_id: str
    table_number: int


class SqlTableMoreOutput(BaseModel):
    table_number: int
    headers: List[str]
    rows: List[List[str]]
    has_more: bool


class ContextQuestionInput(BaseModel):
    user_id: str
    topic: str


class ContextQuestionOutput(BaseModel):
    questions: List[str]


class ContextSaveInput(BaseModel):
    user_id: str
    topic: str
    questions: List[str]
    answers: List[str]


class ContextOutput(BaseModel):
    message: str
    topic: str
    questions: List[str]
    answers: List[str]
    evidence: str


class ContextDirectInput(BaseModel):
    user_id: str
    topic: Optional[str] = ""
    content: str


class DbSelectInput(BaseModel):
    user_id: str
    db_name: str


class SessionData(TypedDict, total=False):
    chat_history: List[Dict[str, Any]]
    context_notes: List[Dict[str, Any]]
    db_name: str
    pending_jobs: Dict[str, Dict[str, Any]]
    completed_jobs: List[str]


def _derive_mcp_api_base() -> str:
    if MCP_DB_URL:
        return MCP_DB_URL.split("/ui", 1)[0]
    return "http://127.0.0.1:1234"

def _ensure_container(user_id: str):
    client = docker.from_env()
    try:
        existing_container = client.containers.get(user_id)
        print(f"Stopping and removing existing container: {user_id}")
        existing_container.stop()
        existing_container.remove()
    except docker.errors.NotFound:
        pass # 컨테이너가 없으면 그냥 진행
    container = client.containers.run(
        PLOT_IMAGE_NAME,
        command="sleep infinity",
        detach=True,
        name=user_id,
    )

MCP_API_BASE = _derive_mcp_api_base().rstrip("/")
MCP_JOBS_ENDPOINT = f"{MCP_API_BASE}/jobs"
DEFAULT_JOB_POLL_INTERVAL = 5
SQL_ROWS_PAGE_SIZE = 200

import re

def is_valid_user_id(user_id: str) -> bool:
    """
    Docker container name 제약 검증 함수.
    (1) [a-z0-9_.-] 문자만 사용 가능
    (2) 영문자 또는 숫자로 시작해야 함
    (3) 길이 ≤ 255
    """
    # (3) 길이 확인
    if not (1 <= len(user_id) <= 255):
        return False

    # (2) 시작 문자 확인
    if not re.match(r'^[a-z0-9]', user_id):
        return False

    # (1) 전체 문자 패턴 확인
    if not re.fullmatch(r'[a-z0-9_.-]+', user_id):
        return False

    return True

def _make_initial_history(user_id: str) -> List[Dict[str, Any]]:
    system_prompt = CHATBOT_SYS_PROMPT.format(
        user_id = user_id
    )
    return [{"role": "system", "content": system_prompt}]


def _ensure_session(user_id: str) -> SessionData:
    session = SESSIONS.get(user_id)
    if session is None:
        session = {"chat_history": _make_initial_history(user_id)}
        SESSIONS[user_id] = session
        _ensure_container(user_id)
    if "chat_history" not in session:
        session["chat_history"] = _make_initial_history(user_id)
    if "context_notes" not in session:
        session["context_notes"] = []
    if "db_name" not in session:
        session["db_name"] = DB_LIST[0] if DB_LIST else ""
    if "pending_jobs" not in session:
        session["pending_jobs"] = {}
    if "completed_jobs" not in session:
        session["completed_jobs"] = []
    if "sql_exec#" not in session:
        session["sql_exec#"] = 0
    if "table_results" not in session:
        session["table_results"] = {}
    return session


async def _push_context_to_ui(*, user_id: str, created_at: str, evidence: str) -> None:
    if not evidence or not MCP_CONTEXT_URL:
        return
    payload = { 
        "text": evidence,
        "user_id": user_id,
        "created_at": created_at,
    }
    try:
        async with httpx.AsyncClient(timeout=5) as client:
            await client.post(MCP_CONTEXT_URL, json=payload)
    except httpx.HTTPError as exc:
        print(f"[context webhook] 전송 실패: {exc}", flush=True)


async def _push_db_selection(*, user_id: str, db_name: str) -> None:
    if not MCP_DB_URL:
        return
    payload = {
        "user_id": user_id,
        "db_name": db_name,
    }
    try:
        async with httpx.AsyncClient(timeout=5) as client:
            await client.post(MCP_DB_URL, json=payload)
    except httpx.HTTPError as exc:
        print(f"[db webhook] 전송 실패: {exc}", flush=True)


def _visible_history(history: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    visible: List[Dict[str, Any]] = []
    for entry in history:
        if entry.get("role") == "system":
            continue
        if entry.get("type") == "internal":
            continue
        content = entry.get("content")
        if content == "SQL 실행해줘.":
            continue
        if isinstance(content, str) and content.startswith("SQL 실행 결과:"):
            continue
        visible.append(entry)
    return visible


async def _fetch_mcp_job(job_id: str) -> Dict[str, Any]:
    job_id = (job_id or "").strip()
    if not job_id:
        raise HTTPException(status_code=400, detail="job_id가 필요합니다.")
    url = f"{MCP_JOBS_ENDPOINT}/{job_id}"
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            response = await client.get(url)
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=502, detail=f"MCP 서버 호출 실패: {exc}") from exc
    if response.status_code == 404:
        return {
            "job_id": job_id,
            "status": "not_found",
        }
    if not response.is_success:
        raise HTTPException(
            status_code=response.status_code,
            detail=f"MCP 서버 호출 실패: {response.text}",
        )
    data = response.json()
    if isinstance(data, dict):
        data.setdefault("job_id", job_id)
        return data
    return {
        "job_id": job_id,
        "status": "error",
        "error": "예상치 못한 응답 형식입니다.",
    }


def _build_sql_success_message(sql_text: str, question: Optional[str] = None) -> str:
    trimmed_sql = (sql_text or "").strip()
    description_lines = ["사용자 요청을 토대로 생성된 SQL입니다."]
    if question:
        description_lines.append(f"질문 요약: {question}")
    description = "\n".join(description_lines)
    return (
        "**SQL**\n``` sql\n"
        f"{trimmed_sql}\n"
        "```\n``` description\n"
        f"{description}\n"
        "```"
    )


def _run_chat_turn(session: SessionData, message: str, user_id: str) -> Dict[str, Any]:
    history = session["chat_history"]
    try:
        result = run_chat_turn(message, history, user_id)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"챗봇 그래프 오류: {exc}") from exc

    pending_job = result.get("pending_job")
    if pending_job:
        job_id = (pending_job.get("job_id") or "").strip()
        if job_id:
            pending_jobs = session.setdefault("pending_jobs", {})
            job_record = {
                "job_id": job_id,
                "question": pending_job.get("question"),
                "status": pending_job.get("status"),
                "suggested_poll_interval": pending_job.get("suggested_poll_interval", DEFAULT_JOB_POLL_INTERVAL),
                "created_at": datetime.utcnow().isoformat() + "Z",
            }
            pending_jobs[job_id] = job_record
            pending_job["suggested_poll_interval"] = job_record["suggested_poll_interval"]

    response_text = result.get("response", "") or ""
    image_data = result.get("image", "")
    if image_data:
        if not history or history[-1].get("image") != image_data:
            history.append(
                {
                    "role": "assistant",
                    "image": image_data,
                },
            )
    return {
        "response": response_text,
        "history": _visible_history(history),
        "img": image_data or "",
        "pending_job": pending_job,
    }


app = FastAPI()
if STATIC_DIR.exists():
    app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

SESSIONS: Dict[str, SessionData] = {}


@app.post("/chat", response_model=PipelineOutput)
async def chat(payload: PipelineInput):
    user_id = payload.user_id.strip()
    if not user_id:
        raise HTTPException(status_code=400, detail="user_id를 입력해 주세요.")

    if not is_valid_user_id(user_id):
        raise HTTPException(status_code=400, detail="user_id 형태가 잘못되었습니다. 영어, 숫자, _.-의 특수문자만 허용됩니다. 특수문자로 시작하면 안됩니다.")

    message = payload.message.strip()
    if not message:
        raise HTTPException(status_code=400, detail="message를 입력해 주세요.")
    
    if payload.mode == "sql":
        message = f"**SQL**\n{message}"

    session = _ensure_session(user_id)
    result = _run_chat_turn(session, message, user_id)

    payload: Dict[str, Any] = {
        "response": result["response"],
        "history": result["history"],
    }
    if result.get("pending_job"):
        payload["pending_job"] = result["pending_job"]
    return payload


@app.get("/chat/history/{user_id}")
async def chat_history(user_id: str):
    user_id = user_id.strip()
    if not user_id:
        return {"history": []}
    session = SESSIONS.get(user_id)
    if not session:
        return {"history": []}
    return {"history": _visible_history(session.get("chat_history", []))}


@app.post("/chat/followup", response_model=FollowUpOutput)
async def chat_followup(payload: FollowUpInput):
    user_id = payload.user_id.strip()
    if not user_id:
        raise HTTPException(status_code=400, detail="user_id를 입력해 주세요.")

    message = payload.message.strip()
    if not message:
        raise HTTPException(status_code=400, detail="message를 입력해 주세요.")

    session = _ensure_session(user_id)
    result = _run_chat_turn(session, message)
    payload: Dict[str, Any] = {
        "response": result["response"],
        "history": result["history"],
        "img": result["img"],
    }
    if result.get("pending_job"):
        payload["pending_job"] = result["pending_job"]
    return payload


@app.post("/chat/sql/execute", response_model=SqlExecuteOutput)
async def chat_sql_execute(payload: SqlExecuteInput):
    user_id = payload.user_id.strip()
    if not user_id:
        raise HTTPException(status_code=400, detail="user_id를 입력해 주세요.")

    sql = payload.sql.strip()
    if not sql:
        raise HTTPException(status_code=400, detail="sql을 입력해 주세요.")
    session = _ensure_session(user_id)
    db_name = session.get("db_name", "EXAMPLE_DATABASE")
    try:
        result = run_sql(sql, db_name, user_id)
    except NotImplementedError as exc:
        return {
            "message": str(exc),
        }
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"SQL 실행 중 오류: {exc}") from exc
    session["sql_exec#"] += 1
    if not isinstance(result, dict):
        return {"message": "SQL 실행을 완료했습니다."}

    message = result.get("message") or "SQL 실행을 완료했습니다."
    headers = result.get("headers") or []
    rows = result.get("rows") or []
    table_info = result.get("table_info")
    csv_text = result.get("csv")
    csv_path = result.get("csv_path")

    page_size = SQL_ROWS_PAGE_SIZE
    visible_rows = rows[:page_size] if rows else []
    has_more = len(rows) > len(visible_rows)
    table_number = session["sql_exec#"]

    response_payload: Dict[str, Any] = {"message": message}
    if headers:
        response_payload["headers"] = headers
    response_payload["rows"] = visible_rows
    if table_info is not None:
        response_payload["table_info"] = table_info
    if csv_path:
        response_payload["csv_path"] = csv_path
    if csv_text is not None and not has_more:
        response_payload["csv"] = csv_text
    response_payload["table_number"] = table_number
    response_payload["has_more"] = has_more

    session = _ensure_session(user_id)
    history = session["chat_history"]
    if message:
        history.append(
            {
                "role": "assistant",
                "type": "text",
                "content": message,
            },
        )

    if headers and rows:
        history.append(
            {
                "role": "assistant",
                "type": "table",
                "headers": headers,
                "rows": visible_rows,
                "table_info": table_info,
                "csv": csv_text if not has_more else None,
                "table#": table_number,
                "has_more": has_more,
            },
        )

    table_results = session.setdefault("table_results", {})
    table_record: Dict[str, Any] = {
        "headers": headers,
        "rows": rows,
        "table_info": table_info,
        "csv_path": csv_path,
        "delivered": len(visible_rows),
        "page_size": page_size,
    }
    if csv_text is not None and not has_more:
        table_record["csv"] = csv_text
    table_results[table_number] = table_record

    response_payload["history"] = _visible_history(history)
    return response_payload


@app.post("/chat/sql/table-more", response_model=SqlTableMoreOutput)
async def chat_sql_table_more(payload: SqlTableMoreInput) -> SqlTableMoreOutput:
    user_id = payload.user_id.strip()
    if not user_id:
        raise HTTPException(status_code=400, detail="user_id를 입력해 주세요.")
    table_number = payload.table_number
    session = _ensure_session(user_id)
    table_results = session.setdefault("table_results", {})
    table_record = table_results.get(table_number)
    if not table_record:
        raise HTTPException(status_code=404, detail="요청한 테이블 데이터를 찾을 수 없습니다.")

    rows: List[List[str]] = table_record.get("rows") or []
    headers: List[str] = table_record.get("headers") or []
    delivered = int(table_record.get("delivered", 0))
    page_size = int(table_record.get("page_size", SQL_ROWS_PAGE_SIZE))

    if delivered >= len(rows):
        table_record["has_more"] = False
        history = session["chat_history"]
        for entry in reversed(history):
            if entry.get("type") == "table" and entry.get("table#") == table_number:
                entry["has_more"] = False
                break
        return SqlTableMoreOutput(
            table_number=table_number,
            headers=headers,
            rows=[],
            has_more=False,
        )

    next_chunk = rows[delivered : delivered + page_size]
    new_delivered = delivered + len(next_chunk)
    table_record["delivered"] = new_delivered
    has_more = new_delivered < len(rows)
    table_record["has_more"] = has_more

    history = session["chat_history"]
    for entry in reversed(history):
        if entry.get("type") == "table" and entry.get("table#") == table_number:
            entry_rows = entry.setdefault("rows", [])
            entry_rows.extend(next_chunk)
            entry["has_more"] = has_more
            break

    normalized_chunk = [
        ["" if cell is None else str(cell) for cell in row]
        for row in next_chunk
    ]

    return SqlTableMoreOutput(
        table_number=table_number,
        headers=headers,
        rows=normalized_chunk,
        has_more=has_more,
    )


@app.get("/chat/sql/job-status/{job_id}")
async def chat_sql_job_status(job_id: str, user_id: Optional[str] = None) -> Dict[str, Any]:
    job_data = await _fetch_mcp_job(job_id)
    if user_id:
        session = SESSIONS.get(user_id)
        if session:
            job_record = session.get("pending_jobs", {}).get(job_id)
            if job_record:
                job_data.setdefault("question", job_record.get("question"))
                job_data.setdefault(
                    "suggested_poll_interval",
                    job_record.get("suggested_poll_interval", DEFAULT_JOB_POLL_INTERVAL),
                )
    return job_data


@app.post("/chat/sql/job-finalize", response_model=SqlJobFinalizeOutput)
async def chat_sql_job_finalize(payload: SqlJobFinalizeInput) -> SqlJobFinalizeOutput:
    user_id = payload.user_id.strip()
    if not user_id:
        raise HTTPException(status_code=400, detail="user_id를 입력해 주세요.")
    job_id = payload.job_id.strip()
    if not job_id:
        raise HTTPException(status_code=400, detail="job_id를 입력해 주세요.")

    session = _ensure_session(user_id)
    pending_jobs = session.setdefault("pending_jobs", {})
    completed_jobs = session.setdefault("completed_jobs", [])

    if job_id in completed_jobs:
        return SqlJobFinalizeOutput(
            status="completed",
            message="이미 처리된 작업입니다.",
            history=_visible_history(session["chat_history"]),
        )

    job_data = await _fetch_mcp_job(job_id)
    status = (job_data.get("status") or "").lower()
    if status not in {"succeeded", "failed", "not_found"}:
        raise HTTPException(status_code=400, detail="작업이 아직 완료되지 않았습니다.")

    job_record = pending_jobs.get(job_id, {})
    question = job_record.get("question")

    if status == "succeeded":
        sql_text = job_data.get("result") or ""
        if not sql_text.strip():
            message = "SQL 생성이 완료되었지만 결과를 확인할 수 없습니다."
        else:
            message = _build_sql_success_message(sql_text, question)
    elif status == "failed":
        error_msg = job_data.get("error") or "원인을 확인하지 못했습니다."
        message = f"SQL 생성에 실패했습니다.\n사유: {error_msg}"
    else:
        message = "SQL 생성 작업을 찾을 수 없습니다. 다시 시도해 주세요."

    session["chat_history"].append(
        {
            "role": "assistant",
            "content": message,
        },
    )
    pending_jobs.pop(job_id, None)
    completed_jobs.append(job_id)
    return SqlJobFinalizeOutput(
        status=status,
        message=message,
        history=_visible_history(session["chat_history"]),
    )


@app.post("/chat/context/questions", response_model=ContextQuestionOutput)
async def generate_context_questions(payload: ContextQuestionInput):
    if not callable(run_promode):
        raise HTTPException(status_code=503, detail="질문 생성 기능이 비활성화되었습니다.")

    user_id = payload.user_id.strip()
    if not user_id:
        raise HTTPException(status_code=400, detail="user_id를 입력해 주세요.")

    topic = payload.topic.strip()
    if not topic:
        raise HTTPException(status_code=400, detail="topic을 입력해 주세요.")

    session = _ensure_session(user_id)
    try:
        questions = run_promode(topic, session["db_name"])
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"추가 질문 생성 실패: {exc}") from exc

    sanitized = [
        question.strip()
        for question in (questions or [])
        if isinstance(question, str) and question.strip()
    ]
    top_three = sanitized[:3]
    if not top_three:
        raise HTTPException(status_code=500, detail="생성된 질문이 없습니다.")

    return {"questions": top_three}


@app.post("/chat/context", response_model=ContextOutput)
async def save_context(payload: ContextSaveInput):
    if not callable(evidence_maker):
        raise HTTPException(status_code=503, detail="evidence_maker가 구성되지 않았습니다.")

    user_id = payload.user_id.strip()
    if not user_id:
        raise HTTPException(status_code=400, detail="user_id를 입력해 주세요.")

    topic = payload.topic.strip()
    if not topic:
        raise HTTPException(status_code=400, detail="topic을 입력해 주세요.")

    raw_questions = payload.questions or []
    raw_answers = payload.answers or []

    questions = [
        question.strip()
        for question in raw_questions
        if isinstance(question, str) and question.strip()
    ]
    answers = [
        answer.strip()
        for answer in raw_answers
        if isinstance(answer, str) and answer.strip()
    ]

    if not questions or not answers:
        raise HTTPException(status_code=400, detail="질문과 답변을 모두 입력해 주세요.")
    if len(questions) != len(answers):
        raise HTTPException(status_code=400, detail="질문 수와 답변 수가 일치하지 않습니다.")

    try:
        evidence = evidence_maker(questions, answers)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"QA 증거 생성 실패: {exc}") from exc

    session = _ensure_session(user_id)
    notes = session.setdefault("context_notes", [])
    created_at = datetime.utcnow().isoformat() + "Z"
    notes.append(
        {
            "type": "qa",
            "topic": topic,
            "questions": questions,
            "answers": answers,
            "evidence": evidence,
            "created_at": created_at,
        },
    )
    await _push_context_to_ui(user_id=user_id, created_at = created_at, evidence=evidence)
    return {
        "message": "추가 정보를 저장했습니다.",
        "topic": topic,
        "questions": questions,
        "answers": answers,
        "evidence": evidence,
    }


@app.post("/chat/context/direct", response_model=ContextOutput)
async def save_context_direct(payload: ContextDirectInput):
    user_id = payload.user_id.strip()
    if not user_id:
        raise HTTPException(status_code=400, detail="user_id를 입력해 주세요.")

    topic = (payload.topic or "").strip() or "직접 입력"
    content = payload.content.strip()
    if not content:
        raise HTTPException(status_code=400, detail="content를 입력해 주세요.")

    session = _ensure_session(user_id)
    notes = session.setdefault("context_notes", [])
    created_at = datetime.utcnow().isoformat() + "Z"
    note = {
        "type": "text",
        "topic": topic,
        "content": content,
        "questions": [],
        "answers": [],
        "evidence": content,
        "created_at": created_at,
    }
    notes.append(note)
    await _push_context_to_ui(user_id=user_id, created_at = created_at, evidence=content)
    return {
        "message": "추가 정보를 저장했습니다.",
        "topic": topic,
        "questions": [],
        "answers": [],
        "evidence": content,
    }


@app.get("/chat/context/{user_id}")
async def read_context_notes(user_id: str):
    trimmed = user_id.strip()
    if not trimmed:
        raise HTTPException(status_code=400, detail="user_id를 입력해 주세요.")
    session = _ensure_session(trimmed)
    notes = session.get("context_notes", [])
    return {"notes": notes}


@app.get("/chat/db/list")
async def read_db_list():
    return {"databases": DB_LIST}


@app.get("/chat/db/{user_id}")
async def read_current_db(user_id: str):
    trimmed = user_id.strip()
    if not trimmed:
        raise HTTPException(status_code=400, detail="user_id를 입력해 주세요.")
    session = _ensure_session(trimmed)
    return {"db_name": session.get("db_name", "")}


@app.post("/chat/db/select")
async def select_db(payload: DbSelectInput):
    user_id = payload.user_id.strip()
    if not user_id:
        raise HTTPException(status_code=400, detail="user_id를 입력해 주세요.")

    db_name = payload.db_name.strip()
    if not db_name:
        raise HTTPException(status_code=400, detail="db_name을 입력해 주세요.")
    if db_name not in DB_LIST:
        raise HTTPException(status_code=400, detail="유효하지 않은 DB입니다.")

    session = _ensure_session(user_id)
    session["db_name"] = db_name
    await _push_db_selection(user_id=user_id, db_name=db_name)
    return {"message": "DB를 변경했습니다.", "db_name": db_name}


@app.get("/")
def read_root():
    index_path = STATIC_DIR / "index.html"
    if not index_path.exists():
        raise HTTPException(
            status_code=503,
            detail="정적 UI 리소스를 찾을 수 없습니다. 'static/index.html'을 확인하세요.",
        )
    return FileResponse(index_path)


@app.get("/api/info")
def api_info():
    return {
        "message": "SQL 파이프라인 없이 바로 대화하는 챗봇입니다.",
        "endpoints": {
            "POST /chat": "대화를 시작합니다.",
            "POST /chat/followup": "대화를 이어갑니다.",
            "GET /chat/history/{user_id}": "현재까지의 대화 이력을 반환합니다.",
            "GET /api/info": "API 정보를 제공합니다.",
        },
    }
