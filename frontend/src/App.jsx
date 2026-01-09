import { useEffect, useMemo, useState } from "react";
import UserSetup from "./components/UserSetup.jsx";
import MessageList from "./components/MessageList.jsx";
import ChatInput from "./components/ChatInput.jsx";

const DEFAULT_STATUS = "사용자 ID를 입력하면 대화를 시작할 수 있어요.";
const SQL_LOADING_MESSAGE = "SQL을 생성 중입니다...";
const USER_ID_MAX_LENGTH = 255;
const USER_ID_ALLOWED_PATTERN = /^[a-z0-9_.-]+$/;
const USER_ID_START_PATTERN = /^[a-z0-9]/;
const isInlineImage = (value) =>
  typeof value === "string" && value.startsWith("data:image/");

const parseSqlFormattedResponse = (raw) => {
  if (typeof raw !== "string") {
    return null;
  }
  const trimmed = raw.trim();
  if (!trimmed.toLowerCase().startsWith("**sql**")) {
    return null;
  }
  const codeBlockRegex = /```[ \t]*sql[ \t]*\n([\s\S]*?)```/i;
  const codeMatch = trimmed.match(codeBlockRegex);
  if (!codeMatch) {
    return null;
  }
  const code = codeMatch[1].trim();
  const before = trimmed.slice(0, codeMatch.index);
  const after = trimmed.slice(codeMatch.index + codeMatch[0].length);
  let remainder = `${before}${after}`.replace(/\*\*sql\*\*/gi, "").trim();
  remainder = remainder.replace(/\n{3,}/g, "\n\n");
  return {
    code,
    description: remainder,
  };
};

const mapHistoryItems = (items = []) =>
  items
    .flatMap((item) => {
      const role = item?.role === "assistant" ? "assistant" : "user";
      const declaredType =
        typeof item?.type === "string" ? item.type.toLowerCase() : "";
      if (declaredType === "table") {
        const headers = Array.isArray(item.headers)
          ? item.headers.map((header) => String(header))
          : [];
        const rows = Array.isArray(item.rows)
          ? item.rows.map((row) =>
              Array.isArray(row)
                ? row.map((cell) => (cell == null ? "" : String(cell)))
                : [],
            )
          : [];
        const rawTableNumber = item?.["table#"] ?? item?.table_number;
        const tableNumber =
          typeof rawTableNumber === "number"
            ? rawTableNumber
            : typeof rawTableNumber === "string" && rawTableNumber.trim()
              ? Number(rawTableNumber)
              : null;
        const hasMore =
          typeof item?.has_more === "boolean"
            ? item.has_more
            : typeof item?.hasMore === "boolean"
              ? item.hasMore
              : false;
        if (headers.length === 0 && rows.length === 0) {
          return [];
        }
        return {
          role,
          type: "table",
          headers,
          rows,
          tableInfo: typeof item.table_info === "string" ? item.table_info : null,
          csv: typeof item.csv === "string" ? item.csv : null,
          csvPath: typeof item.csv_path === "string" ? item.csv_path : null,
          tableNumber: Number.isFinite(tableNumber) ? tableNumber : null,
          hasMore,
        };
      }

      const imagePayload = item?.image || item?.img;
      if (isInlineImage(imagePayload)) {
        return { role, type: "image", src: imagePayload, alt: "생성된 이미지" };
      }
      const content = item?.content ?? "";
      if (role === "assistant" && typeof content === "string") {
        const parsed = parseSqlFormattedResponse(content);
        if (parsed) {
          const nextItems = [
            {
              role,
              type: "code",
              code: parsed.code,
              language: "sql",
            },
          ];
          if (parsed.description) {
            nextItems.push({
              role,
              type: "text",
              content: parsed.description,
            });
          }
          return nextItems;
        }
      }
      return {
        role,
        type: "text",
        content,
      };
    })
    .filter(Boolean);

const getLastAssistantSql = (history = []) => {
  let sqlSnippet = "";
  let seenAssistant = false;
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const item = history[index];
    if (item.role === "assistant") {
      seenAssistant = true;
      if (item.type === "code" && (item.language || "").toLowerCase() === "sql") {
        sqlSnippet = item.code || "";
        break;
      }
    } else if (seenAssistant && item.role === "user") {
      break;
    }
  }
  return sqlSnippet;
};

const applySqlAugmentations = (history, augmentations) => {
  if (!history || history.length === 0) {
    return [];
  }
  let result = [...history];
  Object.entries(augmentations || {}).forEach(([anchor, messages]) => {
    if (!anchor || !Array.isArray(messages) || messages.length === 0) {
      return;
    }
    result = result.filter((item) => item.augmentationAnchor !== anchor);
    const anchorIndex = result.findIndex(
      (item) =>
        item.role === "assistant" &&
        item.type === "code" &&
        (item.code || "") === anchor,
    );
    const augmentedMessages = messages.map((message) => ({
      ...message,
      augmentationAnchor: anchor,
    }));
    if (anchorIndex === -1) {
      result = [...result, ...augmentedMessages];
    } else {
      result = [
        ...result.slice(0, anchorIndex + 1),
        ...augmentedMessages,
        ...result.slice(anchorIndex + 1),
      ];
    }
  });
  return result;
};

const stripSqlLoadingMessages = (history = []) =>
  history.filter(
    (item) => !(item?.role === "assistant" && item?.type === "loading"),
  );

const pruneSqlAugmentations = (history, augmentations) => {
  if (!augmentations || Object.keys(augmentations).length === 0) {
    return augmentations;
  }
  const validAnchors = new Set(
    history
      .filter(
        (item) => item.role === "assistant" && item.type === "code" && item.code,
      )
      .map((item) => item.code),
  );
  return Object.entries(augmentations).reduce((acc, [anchor, messages]) => {
    if (validAnchors.has(anchor)) {
      acc[anchor] = messages;
    }
    return acc;
  }, {});
};

const resolveJson = async (url, options) => {
  const response = await fetch(url, options);
  if (!response.ok) {
    let detail = "";
    try {
      const payload = await response.json();
      detail = payload?.detail || "";
    } catch (_error) {
      // JSON 파싱 실패는 사용자에게 노출하지 않음
    }
    throw new Error(detail || "요청이 실패했습니다.");
  }
  return response.json();
};

const getUserIdValidationMessage = (value, { requireValue = false } = {}) => {
  const trimmed = (value || "").trim();
  if (!trimmed) {
    return requireValue ? "사용자 ID를 입력해 주세요." : "";
  }
  if (trimmed.length > USER_ID_MAX_LENGTH) {
    return `사용자 ID는 최대 ${USER_ID_MAX_LENGTH}자까지 입력할 수 있어요.`;
  }
  if (!USER_ID_START_PATTERN.test(trimmed)) {
    return "사용자 ID는 영문 소문자 또는 숫자로 시작해야 해요.";
  }
  if (!USER_ID_ALLOWED_PATTERN.test(trimmed)) {
    return "사용자 ID는 영문 소문자, 숫자, '_', '-', '.'만 사용할 수 있어요.";
  }
  return "";
};

export default function App() {
  const [pendingUserId, setPendingUserId] = useState("");
  const [currentUserId, setCurrentUserId] = useState("");
  const [statusMessage, setStatusMessage] = useState(DEFAULT_STATUS);
  const [userIdError, setUserIdError] = useState("");
  const [chatHistory, setChatHistory] = useState([]);
  const [sqlAugmentations, setSqlAugmentations] = useState({});
  const [tableMoreLoading, setTableMoreLoading] = useState({});
  const [loading, setLoading] = useState(false);
  const [sqlMode, setSqlMode] = useState(false);
  const [sqlRunning, setSqlRunning] = useState(false);
  const [sqlTesting, setSqlTesting] = useState(false);
  const [lastAssistantSql, setLastAssistantSql] = useState("");
  const [showSqlButton, setShowSqlButton] = useState(false);
  const [currentDbId, setCurrentDbId] = useState("");
  const [dbListCache, setDbListCache] = useState([]);

  const renderedHistory = useMemo(
    () => applySqlAugmentations(chatHistory, sqlAugmentations),
    [chatHistory, sqlAugmentations],
  );

  useEffect(() => {
    const storedId = window.localStorage.getItem("chatbot_user_id");
    if (storedId) {
      setPendingUserId(storedId);
      setUserIdError(getUserIdValidationMessage(storedId));
      setStatusMessage(`${storedId}로 다시 시작하려면 '시작' 버튼을 눌러주세요.`);
    }
  }, []);

  const handlePendingUserIdChange = (value) => {
    setPendingUserId(value);
    const message = getUserIdValidationMessage(value);
    setUserIdError(message);
    if (!currentUserId) {
      setStatusMessage(message || DEFAULT_STATUS);
    }
  };

  const loadHistory = async (userId) => {
    if (!userId) {
      setChatHistory([]);
      setLastAssistantSql("");
      setSqlMode(false);
      setSqlRunning(false);
      setSqlTesting(false);
      setShowSqlButton(false);
      setTableMoreLoading({});
      return;
    }

    setChatHistory([
      {
        role: "assistant",
        type: "text",
        content: "이전 대화를 불러오는 중...",
      },
    ]);
    setTableMoreLoading({});

    try {
      const data = await resolveJson(`/chat/history/${encodeURIComponent(userId)}`);
      const history = Array.isArray(data.history) ? mapHistoryItems(data.history) : [];
      setChatHistory(history);
      setSqlAugmentations((prev) => pruneSqlAugmentations(history, prev));
      const sqlSnippet = getLastAssistantSql(history);
      setLastAssistantSql(sqlSnippet);
      setShowSqlButton(Boolean(sqlSnippet));
      setTableMoreLoading({});
    } catch (error) {
      setChatHistory([
        {
          role: "assistant",
          type: "text",
          content: error.message || "대화 기록을 불러오는 중 오류가 발생했습니다.",
        },
      ]);
      setLastAssistantSql("");
      setSqlMode(false);
      setSqlRunning(false);
      setSqlTesting(false);
      setSqlAugmentations({});
      setShowSqlButton(false);
      setTableMoreLoading({});
    }
  };

  const loadUserDb = async (userId) => {
    try {
      const data = await resolveJson(`/chat/db/${encodeURIComponent(userId)}`);
      const dbId = typeof data.db_id === "string" ? data.db_id.trim() : "";
      setCurrentDbId(dbId);
      return dbId;
    } catch (_error) {
      setCurrentDbId("");
      return "";
    }
  };

  const fetchDbList = async () => {
    if (dbListCache.length) {
      return dbListCache;
    }
    const data = await resolveJson("/chat/db/list");
    const normalized = Array.isArray(data.databases)
      ? data.databases
          .map((item) => (typeof item === "string" ? item.trim() : ""))
          .filter(Boolean)
      : [];
    setDbListCache(normalized);
    return normalized;
  };

  const changeDb = async (dbId) => {
    if (!currentUserId) {
      throw new Error("사용자 ID를 먼저 설정해 주세요.");
    }
    const trimmed = (dbId || "").trim();
    if (!trimmed) {
      throw new Error("변경할 DB를 선택해 주세요.");
    }
    await resolveJson("/chat/db/select", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        user_id: currentUserId,
        db_id: trimmed,
      }),
    });
    setCurrentDbId(trimmed);
    return trimmed;
  };

  const activateUser = async (userId) => {
    const trimmed = userId.trim();
    const validationMessage = getUserIdValidationMessage(trimmed, {
      requireValue: true,
    });
    if (validationMessage) {
      setUserIdError(validationMessage);
      setStatusMessage(validationMessage);
      return;
    }

    if (currentUserId && currentUserId !== trimmed) {
      setSqlAugmentations({});
    }
    setUserIdError("");
    setCurrentUserId(trimmed);
    setPendingUserId(trimmed);
    setStatusMessage(`${trimmed}님, 대화를 시작해 보세요.`);
    window.localStorage.setItem("chatbot_user_id", trimmed);
    setSqlMode(false);
    setCurrentDbId("");
    await loadHistory(trimmed);
    await loadUserDb(trimmed);
  };

  const resetUser = () => {
    setCurrentUserId("");
    setPendingUserId("");
    setChatHistory([]);
    setStatusMessage(DEFAULT_STATUS);
    setUserIdError("");
    window.localStorage.removeItem("chatbot_user_id");
    setSqlMode(false);
    setSqlRunning(false);
    setSqlTesting(false);
    setLastAssistantSql("");
    setSqlAugmentations({});
    setShowSqlButton(false);
    setCurrentDbId("");
    setLoading(false);
  };

  const handleSqlModeToggle = (nextValue) => {
    setSqlMode(Boolean(nextValue));
  };

  const sendMessage = async (message) => {
    const trimmed = message.trim();
    if (!trimmed || !currentUserId || loading) {
      return;
    }

    const userMessage = { role: "user", type: "text", content: trimmed };
    setChatHistory((prev) => {
      const next = [...prev, userMessage];
      if (sqlMode) {
        next.push({
          role: "assistant",
          type: "loading",
          content: SQL_LOADING_MESSAGE,
        });
      }
      return next;
    });
    setLoading(true);

    try {
      const data = await resolveJson("/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          user_id: currentUserId,
          message: trimmed,
          mode: sqlMode ? "sql" : "chat",
        }),
      });

      const history = Array.isArray(data.history) ? mapHistoryItems(data.history) : [];
      if (history.length > 0) {
        setChatHistory(history);
        setSqlAugmentations((prev) => pruneSqlAugmentations(history, prev));
        const sqlSnippet = getLastAssistantSql(history);
        setLastAssistantSql(sqlSnippet);
        setShowSqlButton(Boolean(sqlSnippet));
        setTableMoreLoading({});
      } else {
        const assistantResponse = data.response || "응답이 비어 있습니다.";
        const nextMessages = mapHistoryItems([
          { role: "assistant", content: assistantResponse },
        ]);
        setChatHistory((prev) => {
          const updated = [...stripSqlLoadingMessages(prev), ...nextMessages];
          setSqlAugmentations((augmentations) =>
            pruneSqlAugmentations(updated, augmentations),
          );
          const sqlSnippet = getLastAssistantSql(updated);
          setLastAssistantSql(sqlSnippet);
          setShowSqlButton(Boolean(sqlSnippet));
          return updated;
        });
      }
    } catch (error) {
    setChatHistory((prev) => {
      const updated = [
        ...stripSqlLoadingMessages(prev),
        {
          role: "assistant",
          type: "text",
          content: error.message || "요청 처리 중 오류가 발생했습니다.",
        },
      ];
      setSqlAugmentations((augmentations) =>
        pruneSqlAugmentations(updated, augmentations),
      );
      return updated;
    });
    setSqlRunning(false);
    setSqlTesting(false);
  } finally {
    setLoading(false);
  }
};

  const handleRunSql = async () => {
    if (!currentUserId || !lastAssistantSql || sqlRunning || sqlTesting) {
      return;
    }
    setSqlRunning(true);
    setTableMoreLoading({});
    try {
      const data = await resolveJson("/chat/sql/execute", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          user_id: currentUserId,
          sql: lastAssistantSql,
        }),
      });

      if (Array.isArray(data.history) && data.history.length) {
        const mapped = mapHistoryItems(data.history);
        setChatHistory(mapped);
        setSqlAugmentations((prev) => pruneSqlAugmentations(mapped, prev));
        const sqlSnippet = getLastAssistantSql(mapped);
        setLastAssistantSql(sqlSnippet);
        setShowSqlButton(Boolean(sqlSnippet));
        return;
      }

      const responseText =
        data.message || data.response || "SQL 실행 요청을 완료했습니다.";

      const nextMessages = [
        {
          role: "assistant",
          type: "text",
          content: responseText,
        },
      ];

      const tableHeaders =
        data.headers || data.table_headers || data.columns || [];
      const tableRows = data.rows || data.table_rows || [];
      const rawTableNumber = data.table_number;
      const parsedTableNumber =
        typeof rawTableNumber === "number"
          ? rawTableNumber
          : typeof rawTableNumber === "string" && rawTableNumber.trim()
            ? Number(rawTableNumber)
            : null;
      const tableNumber =
        parsedTableNumber !== null && Number.isFinite(parsedTableNumber)
          ? parsedTableNumber
          : null;
      const hasMore = Boolean(data.has_more);
      const csvPath = typeof data.csv_path === "string" ? data.csv_path : null;
      if (Array.isArray(tableHeaders) && Array.isArray(tableRows) && tableRows.length) {
        const normalizedHeaders = tableHeaders.map((header) => String(header));
        const normalizedRows = tableRows.map((row) =>
          Array.isArray(row)
            ? row.map((cell) => (cell == null ? "" : String(cell)))
            : [],
        );
        nextMessages.push({
          role: "assistant",
          type: "table",
          headers: normalizedHeaders,
          rows: normalizedRows,
          tableInfo: typeof data.table_info === "string" ? data.table_info : null,
          csv: typeof data.csv === "string" ? data.csv : null,
          csvPath,
          tableNumber,
          hasMore,
        });
      }

      const augmentationAnchor = lastAssistantSql;
      const augmentationMessages = nextMessages.map((message) => ({ ...message }));
      setSqlAugmentations((prev) => ({
        ...prev,
        [augmentationAnchor]: augmentationMessages,
      }));
      setShowSqlButton(Boolean(augmentationAnchor));
    } catch (error) {
      const augmentationAnchor = lastAssistantSql;
      setSqlAugmentations((prev) => ({
        ...prev,
        [augmentationAnchor]: [
          {
            role: "assistant",
            type: "text",
            content: error.message || "SQL 실행 중 오류가 발생했습니다.",
          },
        ],
      }));
    } finally {
      setSqlRunning(false);
    }
  };

  const handleTestSql = async () => {
    if (!currentUserId || !lastAssistantSql || sqlRunning || sqlTesting) {
      return;
    }
    setSqlTesting(true);
    setTableMoreLoading({});
    try {
      const data = await resolveJson("/chat/sql/test", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          user_id: currentUserId,
          sql: lastAssistantSql,
        }),
      });

      if (Array.isArray(data.history) && data.history.length) {
        const mapped = mapHistoryItems(data.history);
        setChatHistory(mapped);
        setSqlAugmentations((prev) => pruneSqlAugmentations(mapped, prev));
        const sqlSnippet = getLastAssistantSql(mapped);
        setLastAssistantSql(sqlSnippet);
        setShowSqlButton(Boolean(sqlSnippet));
        return;
      }

      const responseText =
        data.message || data.response || "SQL 테스트 요청을 완료했습니다.";

      const nextMessages = [
        {
          role: "assistant",
          type: "text",
          content: responseText,
        },
      ];

      const tableHeaders =
        data.headers || data.table_headers || data.columns || [];
      const tableRows = data.rows || data.table_rows || [];
      const rawTableNumber = data.table_number;
      const parsedTableNumber =
        typeof rawTableNumber === "number"
          ? rawTableNumber
          : typeof rawTableNumber === "string" && rawTableNumber.trim()
            ? Number(rawTableNumber)
            : null;
      const tableNumber =
        parsedTableNumber !== null && Number.isFinite(parsedTableNumber)
          ? parsedTableNumber
          : null;
      const hasMore = Boolean(data.has_more);
      const csvPath = typeof data.csv_path === "string" ? data.csv_path : null;
      if (Array.isArray(tableHeaders) && Array.isArray(tableRows) && tableRows.length) {
        const normalizedHeaders = tableHeaders.map((header) => String(header));
        const normalizedRows = tableRows.map((row) =>
          Array.isArray(row)
            ? row.map((cell) => (cell == null ? "" : String(cell)))
            : [],
        );
        nextMessages.push({
          role: "assistant",
          type: "table",
          headers: normalizedHeaders,
          rows: normalizedRows,
          tableInfo: typeof data.table_info === "string" ? data.table_info : null,
          csv: typeof data.csv === "string" ? data.csv : null,
          csvPath,
          tableNumber,
          hasMore,
        });
      }

      const augmentationAnchor = lastAssistantSql;
      const augmentationMessages = nextMessages.map((message) => ({ ...message }));
      setSqlAugmentations((prev) => ({
        ...prev,
        [augmentationAnchor]: augmentationMessages,
      }));
      setShowSqlButton(Boolean(augmentationAnchor));
    } catch (error) {
      const augmentationAnchor = lastAssistantSql;
      setSqlAugmentations((prev) => ({
        ...prev,
        [augmentationAnchor]: [
          {
            role: "assistant",
            type: "text",
            content: error.message || "SQL 테스트 중 오류가 발생했습니다.",
          },
        ],
      }));
    } finally {
      setSqlTesting(false);
    }
  };

  const handleLoadMoreTable = async (tableNumber) => {
    if (!currentUserId || typeof tableNumber !== "number" || tableNumber <= 0) {
      return;
    }
    if (tableMoreLoading[tableNumber]) {
      return;
    }
    setTableMoreLoading((prev) => ({ ...prev, [tableNumber]: true }));
    try {
      const data = await resolveJson("/chat/sql/table-more", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          user_id: currentUserId,
          table_number: tableNumber,
        }),
      });
      const nextRows = Array.isArray(data.rows)
        ? data.rows.map((row) =>
            Array.isArray(row)
              ? row.map((cell) => (cell == null ? "" : String(cell)))
              : [],
          )
        : [];
      const hasMore = Boolean(data.has_more);
      setChatHistory((prev) => {
        const updated = prev.map((item) => {
          if (
            item.role === "assistant" &&
            item.type === "table" &&
            item.tableNumber === tableNumber
          ) {
            const mergedRows = Array.isArray(item.rows)
              ? [...item.rows, ...nextRows]
              : [...nextRows];
            return {
              ...item,
              rows: mergedRows,
              hasMore,
            };
          }
          return item;
        });
        setSqlAugmentations((augmentations) =>
          pruneSqlAugmentations(updated, augmentations),
        );
        return updated;
      });
    } catch (error) {
      setChatHistory((prev) => {
        const updated = [
          ...prev,
          {
            role: "assistant",
            type: "text",
            content:
              error.message || "추가 테이블 데이터를 불러오는 중 오류가 발생했습니다.",
          },
        ];
        setSqlAugmentations((augmentations) =>
          pruneSqlAugmentations(updated, augmentations),
        );
        return updated;
      });
    } finally {
      setTableMoreLoading((prev) => {
        const next = { ...prev };
        delete next[tableNumber];
        return next;
      });
    }
  };

  const generateContextQuestions = async (topic) => {
    if (!currentUserId) {
      throw new Error("사용자 ID를 먼저 설정해 주세요.");
    }
    const trimmed = (topic || "").trim();
    if (!trimmed) {
      throw new Error("정보 주제를 입력해 주세요.");
    }
    const data = await resolveJson("/chat/context/questions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        user_id: currentUserId,
        topic: trimmed,
      }),
    });
    const questions = Array.isArray(data.questions)
      ? data.questions.filter(
          (question) => typeof question === "string" && question.trim(),
        )
      : [];
    if (!questions.length) {
      throw new Error("추가 질문 생성에 실패했습니다.");
    }
    return questions;
  };

  const saveContextAnswers = async ({ topic, questions, answers }) => {
    if (!currentUserId) {
      throw new Error("사용자 ID를 먼저 설정해 주세요.");
    }
    const sanitizedTopic = (topic || "").trim();
    if (!sanitizedTopic) {
      throw new Error("정보 주제를 입력해 주세요.");
    }
    const sanitizedQuestions = Array.isArray(questions)
      ? questions.map((question) => (typeof question === "string" ? question.trim() : ""))
      : [];
    const sanitizedAnswers = Array.isArray(answers)
      ? answers.map((answer) => (typeof answer === "string" ? answer.trim() : ""))
      : [];
    if (
      !sanitizedQuestions.length ||
      !sanitizedAnswers.length ||
      sanitizedQuestions.some((value) => !value) ||
      sanitizedAnswers.some((value) => !value)
    ) {
      throw new Error("질문과 답변을 모두 입력해 주세요.");
    }
    if (sanitizedQuestions.length !== sanitizedAnswers.length) {
      throw new Error("질문 수와 답변 수가 일치하지 않습니다.");
    }
    await resolveJson("/chat/context", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        user_id: currentUserId,
        topic: sanitizedTopic,
        questions: sanitizedQuestions,
        answers: sanitizedAnswers,
      }),
    });
  };

  const saveFreeformContext = async ({ topic, content }) => {
    if (!currentUserId) {
      throw new Error("사용자 ID를 먼저 설정해 주세요.");
    }
    const sanitizedContent = (content || "").trim();
    if (!sanitizedContent) {
      throw new Error("바로 추가할 정보를 입력해 주세요.");
    }
    await resolveJson("/chat/context/direct", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        user_id: currentUserId,
        topic: (topic || "").trim(),
        content: sanitizedContent,
      }),
    });
  };

  const fetchContextNotes = async () => {
    if (!currentUserId) {
      throw new Error("사용자 ID를 먼저 설정해 주세요.");
    }
    const data = await resolveJson(
      `/chat/context/${encodeURIComponent(currentUserId)}`,
    );
    const notes = Array.isArray(data.notes)
      ? data.notes.filter((note) => note && typeof note === "object")
      : [];
    return notes;
  };

  const emptyMessage = currentUserId
    ? "안녕하세요! 무엇을 도와드릴까요?"
    : "사용자 ID를 먼저 설정해 주세요.";

  return (
    <div className="app-shell">
      <a
        className="external-link-btn"
        href="http://127.0.0.1:1111"
        target="_blank"
        rel="noopener noreferrer"
      >
        다른 서비스
      </a>
      <div className="chat-container">
        <header className="chat-header">
          <h1>🖥️ LLM Chatbot</h1>
          <p>SQL을 생성 및 실행하여 데이터를 분석해보세요.</p>
        </header>

        <UserSetup
          pendingUserId={pendingUserId}
          onUserIdChange={handlePendingUserIdChange}
          onSubmit={() => activateUser(pendingUserId)}
          statusMessage={statusMessage}
          errorMessage={userIdError}
          disabled={Boolean(currentUserId)}
          onReset={resetUser}
        />

        <main className="chat-window" id="chat-window">
          <MessageList
            messages={renderedHistory}
            emptyMessage={emptyMessage}
            onTableLoadMore={handleLoadMoreTable}
            loadingTables={tableMoreLoading}
          />
        </main>

        <ChatInput
          disabled={!currentUserId}
          loading={loading}
          onSend={sendMessage}
          sqlMode={sqlMode}
          onToggleSqlMode={handleSqlModeToggle}
          clarificationState={null}
          showSqlButton={showSqlButton}
          sqlRunLoading={sqlRunning}
          onRunSql={handleRunSql}
          sqlTestLoading={sqlTesting}
          onTestSql={handleTestSql}
          canAddContext={Boolean(currentUserId)}
          onGenerateContextQuestions={generateContextQuestions}
          onSaveContextAnswers={saveContextAnswers}
          onSaveFreeformContext={saveFreeformContext}
          onFetchContextNotes={fetchContextNotes}
          currentDbId={currentDbId}
          onFetchDbList={fetchDbList}
          onChangeDb={changeDb}
        />
      </div>
    </div>
  );
}
