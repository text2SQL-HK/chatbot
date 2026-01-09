import docker
import io
import tarfile
from pathlib import Path
from typing import Any, Dict, List, Optional, TypedDict
import sys
import importlib.util
try:
    from ..state import SESSIONS, _ensure_session
except ImportError:
    try:
        from tts_chatbot.app.state import SESSIONS, _ensure_session
    except ImportError:
        _app_dir = Path(__file__).resolve().parents[1]
        if str(_app_dir) not in sys.path:
            sys.path.insert(0, str(_app_dir))
        from state import SESSIONS, _ensure_session
try:
    from ..config import PIPELINE_PATH, APP_DIR
except ImportError:
    try:
        from tts_chatbot.app.config import PIPELINE_PATH, APP_DIR
    except ImportError:
        from config import PIPELINE_PATH, APP_DIR

_spec = importlib.util.spec_from_file_location("tts_text_to_sql", PIPELINE_PATH)
if _spec is None or _spec.loader is None:
    raise RuntimeError(f"Unable to load pipeline module from {PIPELINE_PATH}")
_pipeline = importlib.util.module_from_spec(_spec)
sys.modules[_spec.name] = _pipeline
_spec.loader.exec_module(_pipeline)

run_direct = getattr(_pipeline, "run_direct")

# --- 도구 정의 -------------------------------------------------------------------
def normalize_output(output):
    if isinstance(output, (bytes, bytearray)):
        return output.decode("utf-8", errors="replace")
    return str(output)

# --- 도구 메타데이터 정의 ------------------------------------------------------------------- 
TOOLS = [
    {
        "type": "function",
        "name": "plot",
        "description": "Execute the python code(Matplotlib) and draw the plot in the Docker container. The container is identified by the user_id. ",
        "parameters": {
            "type": "object",
            "properties": {
                "code": {
                    "type": "string",
                    "description": "Python code to execute",
                },
                "user_id": {
                    "type": "string",
                    "description": "User ID to identify the Docker container",
                },
            },
            "required": ["code", "user_id"],
        },
    },
    {
        "type": "function",
        "name": "execute_python",
        "description": "Execute the python code in the Docker container. The container is identified by the user_id.",
        "parameters": {
            "type": "object",
            "properties": {
                "code": {
                    "type": "string",
                    "description": "Python code to execute",
                },
                "user_id": {
                    "type": "string",
                    "description": "User ID to identify the Docker container",
                },
            },
            "required": ["code", "user_id"],
        },
    },
    {
        "type": "function",
        "name": "text_to_sql",
        "description": "Execute the python code(Matplotlib) and draw the plot in the Docker container. The container is identified by the user_id. ",
        "parameters": {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "Query to convert to SQL",
                },
                "user_id": {
                    "type": "string",
                    "description": "User ID to identify the Docker container",
                },
            },
            "required": ["query", "user_id"],
        },
    },
]

def plot(code: str, user_id: str) -> str:
    client = docker.from_env()
    print(code)
    try: 
        container = client.containers.get(user_id)
        cmd = ["rm", "-f", "/home/temporary.py"]
        container.exec_run(cmd)
        tar_stream = io.BytesIO()
        with tarfile.open(fileobj=tar_stream, mode="w") as tar:
            data = code.encode()
            info = tarfile.TarInfo(name="temporary.py")
            info.size = len(data)
            tar.addfile(info, io.BytesIO(data))
        tar_stream.seek(0)
        container.put_archive("/home", tar_stream.getvalue())
        exit_code, output = container.exec_run("python /home/temporary.py")
        return "success"
    except Exception as e:
         return f"failed by {e}"

def execute_python(code: str, user_id: str) -> str:
    client = docker.from_env()
    container = client.containers.get(user_id)
    tar_stream = io.BytesIO()
    with tarfile.open(fileobj=tar_stream, mode="w") as tar:
        data = code.encode()
        info = tarfile.TarInfo(name="temporary.py")
        info.size = len(data)
        tar.addfile(info, io.BytesIO(data))
    tar_stream.seek(0)
    container.put_archive("/home", tar_stream.getvalue())
    exit_code, output = container.exec_run("python /home/temporary.py")
    cmd = ["rm", "-f", "/home/temporary.py"]
    container.exec_run(cmd)
    return normalize_output(output)

def text_to_sql(query: str, user_id: str) -> str:
    session = _ensure_session(user_id)
    db_id = session.get("db_id", "EXAMPLE_DATABASE")
    evidence = session.get("evidence", "")
    result = run_direct(question=query, evidence=evidence, db_id=db_id)
    return str(result)
