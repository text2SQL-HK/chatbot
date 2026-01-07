export default function UserSetup({
  pendingUserId,
  onUserIdChange,
  onSubmit,
  statusMessage,
  errorMessage,
  disabled,
  onReset,
}) {
  const handleSubmit = (event) => {
    event.preventDefault();
    if (!disabled && !errorMessage) {
      onSubmit();
    }
  };

  const displayMessage = errorMessage || statusMessage;
  const statusClassName = `user-status${
    errorMessage ? " user-status--error" : ""
  }`;

  return (
    <section className="user-setup">
      <form onSubmit={handleSubmit} autoComplete="off">
        <label htmlFor="user-id">사용자 ID</label>
        <div className="user-input-group">
          <input
            id="user-id"
            type="text"
            placeholder="예: alice123"
            value={pendingUserId}
            onChange={(event) => onUserIdChange(event.target.value)}
            disabled={disabled}
            required
          />
          <button type="submit" disabled={disabled || Boolean(errorMessage)}>
            시작
          </button>
        </div>
      </form>
      <p className={statusClassName}>{displayMessage}</p>
      {disabled && typeof onReset === "function" && (
        <button type="button" className="user-reset" onClick={onReset}>
          사용자 변경
        </button>
      )}
    </section>
  );
}

UserSetup.defaultProps = {
  onReset: undefined,
  errorMessage: "",
};
