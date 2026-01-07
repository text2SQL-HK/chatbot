import { useEffect, useRef } from "react";
import Prism from "prismjs";
import "prismjs/components/prism-sql";

export default function MessageList({
  messages,
  emptyMessage,
  onTableLoadMore,
  loadingTables = {},
}) {
  const containerRef = useRef(null);

  useEffect(() => {
    const node = containerRef.current;
    if (node) {
      node.scrollTo({ top: node.scrollHeight, behavior: "smooth" });
      Prism.highlightAllUnder(node);
    }
  }, [messages]);

  if (!messages || messages.length === 0) {
    return (
      <section className="chat-history" ref={containerRef}>
        <p className="empty-state">{emptyMessage}</p>
      </section>
    );
  }

  return (
    <section className="chat-history" ref={containerRef}>
      {messages.map((item, index) => {
        const role = item.role === "user" ? "user" : "assistant";
        const type = item.type || "text";
        const key = `${role}-${type}-${index}`;

        if (type === "code") {
          const language = item.language || "text";
          return (
            <div className={`message ${role} code-message`} key={key}>
              <div className="content">
                <pre>
                  <code className={`language-${language}`}>{item.code || ""}</code>
                </pre>
              </div>
            </div>
          );
        }

        if (type === "table") {
          const headers = Array.isArray(item.headers) ? item.headers : [];
          const rows = Array.isArray(item.rows) ? item.rows : [];
          const hasTableNumber =
            typeof item.tableNumber === "number" && Number.isFinite(item.tableNumber);
          const tableNumber = hasTableNumber ? item.tableNumber : null;
          const hasMore = Boolean(item.hasMore);
          const isLoadingMore =
            tableNumber !== null && Boolean(loadingTables?.[tableNumber]);
          return (
            <div className={`message ${role} table-message`} key={key}>
              <div className="content">
                {hasTableNumber && (
                  <div className="table-caption">{`테이블 #${item.tableNumber}`}</div>
                )}
                <table className="result-table">
                  {headers.length > 0 && (
                    <thead>
                      <tr>
                        {headers.map((header, headerIndex) => (
                          <th key={`${key}-header-${headerIndex}`}>{header}</th>
                        ))}
                      </tr>
                    </thead>
                  )}
                  {rows.length > 0 && (
                    <tbody>
                      {rows.map((row, rowIndex) => (
                        <tr key={`${key}-row-${rowIndex}`}>
                          {row.map((cell, cellIndex) => (
                            <td key={`${key}-cell-${rowIndex}-${cellIndex}`}>{cell}</td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  )}
                </table>
                {hasMore && (
                  <button
                    type="button"
                    className="table-load-more"
                    onClick={() => {
                      if (typeof onTableLoadMore === "function" && tableNumber !== null) {
                        onTableLoadMore(tableNumber);
                      }
                    }}
                    disabled={
                      typeof onTableLoadMore !== "function" ||
                      tableNumber === null ||
                      isLoadingMore
                    }
                  >
                    {isLoadingMore ? "불러오는 중..." : "더 보기"}
                  </button>
                )}
              </div>
            </div>
          );
        }
        if (type === "image") {
          return (
            <div className={`message ${role} image-message`} key={key}>
              <div className="content">
                <img src={item.src} alt={item.alt || ""} />
              </div>
            </div>
          );
        }
        const content = item.content ?? "";
        return (
          <div className={`message ${role}`} key={key}>
            <div className="content">{content}</div>
          </div>
        );
      })}
    </section>
  );
}
