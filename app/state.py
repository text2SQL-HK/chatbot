from __future__ import annotations

from typing import Any, Dict, List, TypedDict
import docker
from pathlib import Path
import json
if __package__:
    from .config import CHATBOT_SYS_PROMPT, DB_LIST, PLOT_IMAGE_NAME
else:
    from config import CHATBOT_SYS_PROMPT, DB_LIST, PLOT_IMAGE_NAME

class SessionData(TypedDict, total=False):
    chat_history: List[Dict[str, Any]]
    context_notes: List[Dict[str, Any]]
    db_id: str

SESSIONS: Dict[str, SessionData] = {}

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
    if "db_id" not in session:
        session["db_id"] = DB_LIST[0] if DB_LIST else ""
    if "sql_exec#" not in session:
        session["sql_exec#"] = 0
    if "table_results" not in session:
        session["table_results"] = {}
    return session

def _make_initial_history(user_id: str) -> List[Dict[str, Any]]:
    system_prompt = CHATBOT_SYS_PROMPT.format(
        user_id = user_id
    )
    return [{"role": "system", "content": system_prompt}]

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
