import os
from pathlib import Path
import json

#유틸
def load_prompt(path: Path) -> str:
    if not path.exists():
        raise FileNotFoundError(f"Prompt file not found: {path}")
    return path.read_text(encoding="utf-8")

#설정 값들
BASE_DIR = Path(__file__).resolve().parent.parent
APP_DIR = BASE_DIR / "app"
PIPELINE_PATH = APP_DIR / "services" / "tts_pipeline.py"
CHAT_PATH = APP_DIR / "services" / "chat.py"
DB_LIST_PATH = Path(os.environ.get("DB_LIST_PATH") or (APP_DIR / "metadata" / "db_list.json"))
if DB_LIST_PATH.is_file():
    with open(DB_LIST_PATH, "r", encoding="utf-8") as f:
        loaded = json.load(f)
else:
    loaded = []
tables_data = loaded if isinstance(loaded, list) else [loaded]
DB_LIST = [table_data["db_id"] for table_data in tables_data]
PLOT_IMAGE_NAME = "plot"
PLOT_TMP_DIR = "/home"
PROMPT_DIR = APP_DIR / "prompts"
CHATBOT_SYS_PROMPT = load_prompt(PROMPT_DIR / "SYS_PROMPT-mod.txt")
STATIC_DIR = APP_DIR / "static"
SQL_ROWS_PAGE_SIZE = 200
RERANK_URL = os.environ.get("RERANK_URL", "http://localhost:8002/rerank")
ORACLE_JSON_PATH = Path(os.environ.get("ORACLE_JSON_PATH") or (Path(APP_DIR / "metadata" / "ORACLE_INFO.json")))