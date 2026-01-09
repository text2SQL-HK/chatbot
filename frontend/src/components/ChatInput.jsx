import { useEffect, useRef, useState } from "react";

const getScrollHeight = (element) => {
  if (!element) {
    return 0;
  }
  const savedValue = element.value;
  element.value = "";
  const baseScrollHeight = element.scrollHeight;
  element.value = savedValue;
  return baseScrollHeight;
};

const autoExpandTextarea = (element) => {
  if (!element) {
    return;
  }
  const minRows = Number(element.getAttribute("data-min-rows")) || 1;
  if (!element._baseScrollHeight) {
    element._baseScrollHeight = getScrollHeight(element);
  }
  const lineHeight =
    parseInt(
      (typeof window !== "undefined" &&
        window.getComputedStyle(element).lineHeight) ||
        "16",
      10,
    ) || 16;

  element.rows = minRows;
  const rows = Math.ceil(
    (element.scrollHeight - element._baseScrollHeight) / lineHeight,
  );
  element.rows = minRows + rows;
};

export default function ChatInput({
  disabled,
  loading,
  onSend,
  sqlMode,
  onToggleSqlMode,
  clarificationState,
  showSqlButton = false,
  sqlRunLoading = false,
  sqlTestLoading = false,
  onRunSql = () => {},
  onTestSql = () => {},
  canAddContext = false,
  onGenerateContextQuestions = async () => [],
  onSaveContextAnswers = async () => {},
  onFetchContextNotes = async () => [],
  onSaveFreeformContext = async () => {},
  currentDbId = "",
  onFetchDbList = async () => [],
  onChangeDb = async () => {},
}) {
  const [message, setMessage] = useState("");
  const [isContextModalOpen, setIsContextModalOpen] = useState(false);
  const [contextTopic, setContextTopic] = useState("");
  const [contextFreeform, setContextFreeform] = useState("");
  const [generatedQuestions, setGeneratedQuestions] = useState([]);
  const [contextAnswers, setContextAnswers] = useState([]);
  const [contextStage, setContextStage] = useState("topic");
  const [contextGenerating, setContextGenerating] = useState(false);
  const [contextSubmitting, setContextSubmitting] = useState(false);
  const [contextFeedback, setContextFeedback] = useState(null);
  const [contextNotes, setContextNotes] = useState([]);
  const [contextNotesLoading, setContextNotesLoading] = useState(false);
  const [contextNotesError, setContextNotesError] = useState(null);
  const [isDbModalOpen, setIsDbModalOpen] = useState(false);
  const [dbList, setDbList] = useState([]);
  const [dbLoading, setDbLoading] = useState(false);
  const [dbSubmitting, setDbSubmitting] = useState(false);
  const [dbError, setDbError] = useState(null);
  const [dbSelection, setDbSelection] = useState("");
  const [isDbDropdownOpen, setIsDbDropdownOpen] = useState(false);
  const [dbActiveIndex, setDbActiveIndex] = useState(-1);
  const dbDropdownRef = useRef(null);
  const dbTriggerRef = useRef(null);
  const dbListRef = useRef(null);
  const messageInputRef = useRef(null);

  const closeDbDropdown = ({ focusTrigger = true } = {}) => {
    setIsDbDropdownOpen(false);
    setDbActiveIndex(-1);
    if (focusTrigger) {
      setTimeout(() => {
        dbTriggerRef.current?.focus();
      }, 0);
    }
  };

  const openDbDropdown = (initialIndex) => {
    if (dbLoading || !dbList.length) {
      return;
    }
    let nextIndex = typeof initialIndex === "number" ? initialIndex : -1;
    if (nextIndex < 0 || nextIndex >= dbList.length) {
      const currentIndex = dbList.findIndex((item) => item === dbSelection);
      nextIndex = currentIndex >= 0 ? currentIndex : 0;
    }
    setDbActiveIndex(nextIndex);
    setIsDbDropdownOpen(true);
  };

  const toggleDbDropdown = () => {
    if (dbLoading || !dbList.length) {
      return;
    }
    if (isDbDropdownOpen) {
      closeDbDropdown();
    } else {
      openDbDropdown();
    }
  };

  const handleDbOptionSelect = (dbId) => {
    setDbSelection(dbId);
    closeDbDropdown();
  };

  const handleDbTriggerKeyDown = (event) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const targetIndex =
        event.key === "ArrowUp" && dbList.length ? dbList.length - 1 : 0;
      openDbDropdown(targetIndex);
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (isDbDropdownOpen) {
        closeDbDropdown();
      } else {
        openDbDropdown();
      }
    }
  };

  const handleDbDropdownKeyDown = (event) => {
    if (!isDbDropdownOpen) {
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (!dbList.length) {
        return;
      }
      setDbActiveIndex((prev) => {
        const base = prev >= 0 ? prev : 0;
        const next = base + 1 >= dbList.length ? 0 : base + 1;
        setTimeout(() => {
          const option = document.getElementById(`db-option-${next}`);
          option?.scrollIntoView({ block: "nearest" });
        }, 0);
        return next;
      });
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      if (!dbList.length) {
        return;
      }
      setDbActiveIndex((prev) => {
        const next =
          prev <= 0 || prev === -1 ? dbList.length - 1 : prev - 1;
        setTimeout(() => {
          const option = document.getElementById(`db-option-${next}`);
          option?.scrollIntoView({ block: "nearest" });
        }, 0);
        return next;
      });
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (dbActiveIndex >= 0 && dbActiveIndex < dbList.length) {
        handleDbOptionSelect(dbList[dbActiveIndex]);
      }
    } else if (event.key === "Escape") {
      event.preventDefault();
      closeDbDropdown();
    } else if (event.key === "Tab") {
      closeDbDropdown({ focusTrigger: false });
    }
  };

  useEffect(() => {
    if (!isDbDropdownOpen) {
      return undefined;
    }
    const handlePointerDown = (event) => {
      if (
        dbDropdownRef.current &&
        !dbDropdownRef.current.contains(event.target) &&
        dbTriggerRef.current &&
        !dbTriggerRef.current.contains(event.target)
      ) {
        closeDbDropdown({ focusTrigger: false });
      }
    };
    const handleEscape = (event) => {
      if (event.key === "Escape") {
        closeDbDropdown();
      }
    };
    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("touchstart", handlePointerDown);
    document.addEventListener("keydown", handleEscape);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("touchstart", handlePointerDown);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [isDbDropdownOpen]);

  useEffect(() => {
    if (!isDbDropdownOpen) {
      return;
    }
    setTimeout(() => {
      dbListRef.current?.focus();
    }, 0);
  }, [isDbDropdownOpen]);

  useEffect(() => {
    if (!isDbModalOpen) {
      closeDbDropdown({ focusTrigger: false });
    }
  }, [isDbModalOpen]);

  useEffect(() => {
    if (!isDbDropdownOpen) {
      return;
    }
    const currentIndex = dbList.findIndex((item) => item === dbSelection);
    if (currentIndex >= 0) {
      setDbActiveIndex(currentIndex);
    } else if (dbList.length) {
      setDbActiveIndex(0);
    } else {
      setDbActiveIndex(-1);
    }
  }, [dbList, dbSelection, isDbDropdownOpen]);

  const handleSubmit = (event) => {
    event.preventDefault();
    const trimmed = message.trim();
    if (!trimmed || disabled || loading) {
      return;
    }
    onSend(trimmed);
    setMessage("");
  };

  const handleMessageChange = (event) => {
    setMessage(event.target.value);
    autoExpandTextarea(event.target);
  };

  const handleMessageKeyDown = (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      handleSubmit(event);
    }
  };

  const clarificationActive =
    clarificationState && typeof clarificationState === "object";
  const placeholder = (() => {
    if (sqlMode || clarificationActive) {
      if (clarificationActive) {
        const index = clarificationState.index || 1;
        const total = clarificationState.total || 1;
        return `추가 질문 ${index}/${total}에 대한 답변을 입력하세요...`;
      }
      return "분석할 질문을 입력하세요...";
    }
    return "질문을 입력하세요...";
  })();

  useEffect(() => {
    autoExpandTextarea(messageInputRef.current);
  }, [message]);

  const loadContextNotes = async () => {
    setContextNotesError(null);
    setContextNotesLoading(true);
    try {
      const notes = await onFetchContextNotes();
      setContextNotes(notes);
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "저장된 정보를 불러오는 중 오류가 발생했습니다.";
      setContextNotesError(message);
    } finally {
      setContextNotesLoading(false);
    }
  };

  const loadDbOptions = async () => {
    setDbError(null);
    setDbLoading(true);
    try {
      const list = await onFetchDbList();
      const normalized = Array.isArray(list)
        ? list
            .map((item) => (typeof item === "string" ? item.trim() : ""))
            .filter(Boolean)
        : [];
      setDbList(normalized);
      const trimmedCurrent = (currentDbId || "").trim();
      const defaultSelection = normalized.includes(trimmedCurrent)
        ? trimmedCurrent
        : normalized[0] || "";
      setDbSelection(defaultSelection);
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "DB 목록을 불러오는 중 오류가 발생했습니다.";
      setDbError(message);
    } finally {
      setDbLoading(false);
    }
  };

  const openContextModal = () => {
    setIsContextModalOpen(true);
    setContextStage("topic");
    setContextTopic("");
    setContextFreeform("");
    setGeneratedQuestions([]);
    setContextAnswers([]);
    setContextFeedback(null);
    setContextGenerating(false);
    setContextSubmitting(false);
    setContextNotes([]);
    setContextNotesError(null);
    loadContextNotes();
  };

  const openDbModal = () => {
    setIsDbModalOpen(true);
    setDbError(null);
    setDbSelection("");
    setDbList([]);
    setDbSubmitting(false);
    setIsDbDropdownOpen(false);
    setDbActiveIndex(-1);
    loadDbOptions();
  };

  const closeContextModal = () => {
    setIsContextModalOpen(false);
    setContextSubmitting(false);
    setContextTopic("");
    setContextFreeform("");
    setGeneratedQuestions([]);
    setContextAnswers([]);
    setContextStage("topic");
    setContextFeedback(null);
    setContextGenerating(false);
    setContextNotes([]);
    setContextNotesError(null);
    setContextNotesLoading(false);
  };

  const closeDbModal = () => {
    closeDbDropdown({ focusTrigger: false });
    setIsDbModalOpen(false);
    setDbLoading(false);
    setDbSubmitting(false);
    setDbError(null);
    setIsDbDropdownOpen(false);
  };

  const handleGenerateContextQuestions = async () => {
    const trimmedTopic = contextTopic.trim();
    if (!trimmedTopic) {
      setContextFeedback({ type: "error", message: "정보 주제를 입력해 주세요." });
      return;
    }
    setContextGenerating(true);
    setContextFeedback(null);
    try {
      const questions = await onGenerateContextQuestions(trimmedTopic);
      if (!questions || !questions.length) {
        setContextFeedback({
          type: "error",
          message: "추가 질문을 생성하지 못했습니다.",
        });
        return;
      }
      setGeneratedQuestions(questions);
      setContextAnswers(Array(questions.length).fill(""));
      setContextStage("qa");
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "질문을 생성하는 중 오류가 발생했습니다.";
      setContextFeedback({ type: "error", message });
    } finally {
      setContextGenerating(false);
    }
  };

  const handleAnswerChange = (index, value) => {
    setContextAnswers((prev) => {
      const next = [...prev];
      next[index] = value;
      return next;
    });
  };

  const handleContextSave = async () => {
    const trimmedAnswers = contextAnswers.map((answer) => answer.trim());
    const hasEmpty = trimmedAnswers.some((answer) => !answer);
    if (hasEmpty) {
      setContextFeedback({
        type: "error",
        message: "모든 질문에 대한 답변을 입력해 주세요.",
      });
      return;
    }

    setContextSubmitting(true);
    setContextFeedback(null);
    try {
      await onSaveContextAnswers({
        topic: contextTopic,
        questions: generatedQuestions,
        answers: trimmedAnswers,
      });
      await loadContextNotes();
      setContextFeedback({ type: "success", message: "저장했습니다." });
      setContextStage("topic");
      setGeneratedQuestions([]);
      setContextAnswers([]);
      setContextFreeform("");
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "정보를 저장하는 중 문제가 발생했습니다.";
      setContextFeedback({ type: "error", message });
    } finally {
      setContextSubmitting(false);
    }
  };

  const resetContextFlow = () => {
    setContextStage("topic");
    setGeneratedQuestions([]);
    setContextAnswers([]);
    setContextFeedback(null);
    setContextGenerating(false);
    setContextFreeform("");
    setContextNotes([]);
    setContextNotesError(null);
    setContextNotesLoading(false);
  };

  const handleDirectContextSave = async () => {
    const trimmedContent = contextFreeform.trim();
    if (!trimmedContent) {
      setContextFeedback({
        type: "error",
        message: "바로 추가할 정보를 입력해 주세요.",
      });
      return;
    }
    setContextSubmitting(true);
    setContextFeedback(null);
    try {
      await onSaveFreeformContext({
        topic: contextTopic,
        content: trimmedContent,
      });
      await loadContextNotes();
      setContextFeedback({ type: "success", message: "바로 저장했습니다." });
      setContextFreeform("");
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "정보를 저장하는 중 문제가 발생했습니다.";
      setContextFeedback({ type: "error", message });
    } finally {
      setContextSubmitting(false);
    }
  };

  const handleDbSave = async () => {
    const trimmed = dbSelection.trim();
    if (!trimmed) {
      setDbError("변경할 DB를 선택해 주세요.");
      return;
    }
    setDbSubmitting(true);
    setDbError(null);
    try {
      await onChangeDb(trimmed);
      closeDbModal();
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "DB 변경 중 문제가 발생했습니다.";
      setDbError(message);
    } finally {
      setDbSubmitting(false);
    }
  };

  const formatNoteDate = (value) => {
    if (!value) {
      return "";
    }
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      return value;
    }
    return date.toLocaleString("ko-KR", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  };

  return (
    <form className="chat-input" onSubmit={handleSubmit} autoComplete="off">
      <div className="input-actions">
        <label className="sql-switch">
          <input
            type="checkbox"
            checked={sqlMode}
            onChange={(event) => onToggleSqlMode(event.target.checked)}
          />
          <span className="switch-track" aria-hidden="true">
            <span className="switch-thumb" />
          </span>
          <span className="switch-label">SQL 모드</span>
        </label>
        {canAddContext && (
          <>
            <button
              type="button"
              className="add-context-button"
              onClick={openContextModal}
              disabled={disabled || loading}
            >
              정보 추가하기
            </button>
            <button
              type="button"
              className="db-change-button"
              onClick={openDbModal}
              disabled={disabled || loading}
            >
              DB 변경하기
            </button>
            <span className="db-indicator">
              현재 DB: {currentDbId ? currentDbId : "미선택"}
            </span>
          </>
        )}
        {showSqlButton && (
          <>
            <button
              type="button"
              className="sql-generate-button"
              disabled={disabled || loading || sqlRunLoading || sqlTestLoading}
              onClick={onRunSql}
            >
              SQL 실행하기
            </button>
            <button
              type="button"
              className="sql-test-button"
              disabled={disabled || loading || sqlRunLoading || sqlTestLoading}
              onClick={onTestSql}
            >
              SQL 테스트하기
            </button>
          </>
        )}
      </div>
      <div className="input-row">
        <div className="input-wrapper">
          <textarea
            ref={messageInputRef}
            id="message"
            name="message"
            className="input-field pipeline autoExpand"
            placeholder={placeholder}
            value={message}
            onChange={handleMessageChange}
            onKeyDown={handleMessageKeyDown}
            disabled={disabled || loading}
            rows={1}
            data-min-rows="1"
            spellCheck={false}
            required
          />
          <button
            type="submit"
            id="send-button"
            className="send-button"
            disabled={disabled || loading}
            aria-label="메시지 전송"
          >
            <svg
              aria-hidden="true"
              className="send-icon"
              viewBox="0 0 24 24"
              focusable="false"
            >
              <path
                d="M12 5v14m0-14 5 5m-5-5-5 5"
                fill="none"
                stroke="#000000"
                strokeWidth="2.6"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            <span className="sr-only">{loading ? "전송 중" : "전송"}</span>
          </button>
        </div>
      </div>
      {isDbModalOpen && (
        <div
          className="context-modal-backdrop db-modal-backdrop"
          role="dialog"
          aria-modal="true"
        >
          <div className="context-modal db-modal">
            <div className="context-modal-header">
              <div className="context-modal-title">
                <h2>DB 변경하기</h2>
                <p className="db-modal-subtitle">
                  사용할 데이터베이스를 선택하세요.
                </p>
              </div>
              <button
                type="button"
                className="context-close-button"
                aria-label="DB 변경 닫기"
                onClick={closeDbModal}
              >
                ×
              </button>
            </div>
            <div className="db-modal-body">
          {dbLoading ? (
            <p className="db-modal-subtitle">DB 목록을 불러오는 중...</p>
          ) : dbList.length ? (
            <div className="db-dropdown" ref={dbDropdownRef}>
              <button
                type="button"
                className="db-dropdown-trigger"
                onClick={toggleDbDropdown}
                onKeyDown={handleDbTriggerKeyDown}
                ref={dbTriggerRef}
                aria-haspopup="listbox"
                aria-expanded={isDbDropdownOpen}
                disabled={dbSubmitting}
              >
                <span>{dbSelection || "DB를 선택하세요"}</span>
                <span aria-hidden="true" className="db-dropdown-icon">
                  ▾
                </span>
              </button>
              {isDbDropdownOpen && (
                <div
                  className="db-dropdown-menu"
                  role="listbox"
                  tabIndex={-1}
                  ref={dbListRef}
                  onKeyDown={handleDbDropdownKeyDown}
                  aria-activedescendant={
                    dbActiveIndex >= 0 ? `db-option-${dbActiveIndex}` : undefined
                  }
                >
                  {dbList.map((dbId, index) => {
                    const isSelected = dbSelection === dbId;
                    const isActive = dbActiveIndex === index;
                    return (
                      <button
                        key={dbId}
                        type="button"
                        id={`db-option-${index}`}
                        role="option"
                        aria-selected={isSelected}
                        className={`db-dropdown-option${isActive ? " active" : ""}${isSelected ? " selected" : ""}`}
                        onClick={() => handleDbOptionSelect(dbId)}
                        onMouseEnter={() => setDbActiveIndex(index)}
                        disabled={dbSubmitting}
                      >
                        {dbId}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          ) : (
            <p className="db-modal-subtitle">선택할 수 있는 DB가 없습니다.</p>
          )}
              {dbError && (
                <p className="db-modal-error" role="status">
                  {dbError}
                </p>
              )}
            </div>
            <div className="context-modal-actions">
              <button
                type="button"
                className="context-secondary-button"
                onClick={closeDbModal}
                disabled={dbSubmitting}
              >
                취소
              </button>
              <button
                type="button"
                className="context-primary-button"
                onClick={handleDbSave}
                disabled={
                  dbSubmitting || dbLoading || !dbSelection || !dbList.length
                }
              >
                {dbSubmitting ? "변경 중..." : "변경"}
              </button>
            </div>
          </div>
        </div>
      )}
      {isContextModalOpen && (
        <div className="context-modal-backdrop" role="dialog" aria-modal="true">
          <div className="context-modal">
            <div className="context-modal-header">
              <div className="context-modal-title">
                <h2>SQL 생성을 위한 추가 정보 입력</h2>
                <p className="context-modal-subtitle">
                  이 곳에 추가된 정보는 SQL 생성에만 이용됩니다.
                </p>
              </div>
              <button
                type="button"
                className="context-close-button"
                aria-label="추가 정보 입력 닫기"
                onClick={closeContextModal}
              >
                ×
              </button>
            </div>
            <div className="context-stage">
              <span
                className={`context-stage-pill ${contextStage === "topic" ? "active" : ""}`}
              >
                1. 주제 입력
              </span>
              <span
                className={`context-stage-pill ${contextStage === "qa" ? "active" : ""}`}
              >
                2. 질문 답변
              </span>
              <button
                type="button"
                className="context-stage-pill context-stage-button"
                onClick={loadContextNotes}
                disabled={contextNotesLoading}
              >
                {contextNotesLoading ? "갱신 중..." : "새로 고침"}
              </button>
            </div>
            <div className="context-notes-panel">
              <p className="context-notes-title">현재 추가된 정보</p>
              {contextNotesLoading && (
                <p className="context-notes-status">저장된 정보를 불러오는 중...</p>
              )}
              {contextNotesError && (
                <p className="context-modal-feedback error" role="status">
                  {contextNotesError}
                </p>
              )}
              {!contextNotesLoading && !contextNotesError && (
                <>
                  {contextNotes.length === 0 ? (
                    <p className="context-notes-status">아직 추가된 정보가 없습니다.</p>
                  ) : (
                    <div className="context-notes-list">
                      {contextNotes.map((note, index) => {
                        const noteKey = note?.created_at || `${note?.topic || "note"}-${index}`;
                        const questions = Array.isArray(note?.questions)
                          ? note.questions
                          : [];
                        const answers = Array.isArray(note?.answers) ? note.answers : [];
                        const pairs = questions.map((question, idx) => ({
                          question,
                          answer: answers[idx],
                        }));
                        return (
                          <div className="context-note-card" key={noteKey}>
                            <div className="context-note-header">
                              <strong>{note?.topic || `정보 ${index + 1}`}</strong>
                              {note?.created_at && (
                                <span>{formatNoteDate(note.created_at)}</span>
                              )}
                            </div>
                            {pairs.length > 0 ? (
                              <ul className="context-note-qa">
                                {pairs.map((pair, pairIdx) => (
                                  <li key={`${noteKey}-qa-${pairIdx}`}>
                                    <p className="context-note-question">
                                      Q{pairIdx + 1}. {pair.question}
                                    </p>
                                    {pair.answer && (
                                      <p className="context-note-answer">A. {pair.answer}</p>
                                    )}
                                  </li>
                                ))}
                              </ul>
                            ) : (
                              <p className="context-note-evidence">
                                {note?.evidence || "저장된 상세 내용이 없습니다."}
                              </p>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </>
              )}
            </div>
            {contextStage === "topic" && (
              <>
                <p className="context-modal-subtitle">
                  먼저 추가 정보를 얻고 싶은 주제를 입력하면 챗봇이 3개의 핵심 질문을
                  만들어 드립니다.
                </p>
                <textarea
                  rows={4}
                  className="context-modal-textarea"
                  placeholder="예) A 공정의 CYCLE TIME을 계산하고 싶어요."
                  value={contextTopic}
                  onChange={(event) => setContextTopic(event.target.value)}
                  disabled={contextGenerating || contextSubmitting}
                  spellCheck={false}
                />
                <p className="context-modal-subtitle subtle">
                  또는 아래 입력란에 바로 추가하고 싶은 정보를 적고 저장할 수 있어요.
                </p>
                <textarea
                  rows={4}
                  className="context-modal-textarea"
                  placeholder="바로 저장할 정보를 입력하세요."
                  value={contextFreeform}
                  onChange={(event) => setContextFreeform(event.target.value)}
                  disabled={contextSubmitting}
                  spellCheck={false}
                />
              </>
            )}
            {contextStage === "qa" && (
              <div className="context-question-list">
                <p className="context-modal-subtitle">
                  아래 질문에 답변하면 QA 형태로 정리되어 세션에 저장됩니다.
                </p>
                {generatedQuestions.map((question, index) => (
                  <div className="context-question-card" key={`question-${index}`}>
                    <p className="context-question-label">
                      Q{index + 1}. {question}
                    </p>
                    <textarea
                      rows={3}
                      className="context-answer-textarea"
                      placeholder="여기에 답변을 입력하세요."
                      value={contextAnswers[index] || ""}
                      onChange={(event) => handleAnswerChange(index, event.target.value)}
                      disabled={contextSubmitting}
                      spellCheck={false}
                    />
                  </div>
                ))}
              </div>
            )}
            {contextFeedback && (
              <p
                className={`context-modal-feedback ${contextFeedback.type === "error" ? "error" : "success"}`}
                role="status"
              >
                {contextFeedback.message}
              </p>
            )}
            <div className="context-modal-actions">
              {contextStage === "qa" && (
                <button
                  type="button"
                  className="context-secondary-button"
                  onClick={resetContextFlow}
                  disabled={contextSubmitting}
                >
                  처음으로
                </button>
              )}
              <button
                type="button"
                className="context-secondary-button"
                onClick={closeContextModal}
                disabled={contextSubmitting || contextGenerating}
              >
                닫기
              </button>
              {contextStage === "topic" ? (
                <>
                  <button
                    type="button"
                    className="context-secondary-button"
                    onClick={handleDirectContextSave}
                    disabled={contextSubmitting || !contextFreeform.trim()}
                  >
                    {contextSubmitting ? "저장 중..." : "바로 저장"}
                  </button>
                  <button
                    type="button"
                    className="context-primary-button"
                    onClick={handleGenerateContextQuestions}
                    disabled={contextGenerating || contextSubmitting}
                  >
                    {contextGenerating ? "생성 중..." : "질문 생성"}
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  className="context-primary-button"
                  onClick={handleContextSave}
                  disabled={contextSubmitting}
                >
                  {contextSubmitting ? "저장 중..." : "저장"}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </form>
  );
}
