import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { AUTH_TOKEN_STORAGE_KEY, AUTH_REQUIRED_EVENT } from '../desktop-client';

interface TokenGateProps {
  readonly children: ReactNode;
}

/** 令牌无效/失效时统一展示的提示文案。 */
const INVALID_TOKEN_MESSAGE = '令牌无效，请重新输入';

function readStoredToken(): string | null {
  try {
    return localStorage.getItem(AUTH_TOKEN_STORAGE_KEY);
  } catch {
    return null;
  }
}

function storeToken(token: string): void {
  try {
    localStorage.setItem(AUTH_TOKEN_STORAGE_KEY, token);
  } catch {
    // localStorage 不可用：仍继续走一次校验请求（token 只存在于本次提交中）
  }
}

/**
 * 包在 `<App/>` 外的访问令牌门（B12：Web 形态）。
 *
 * localStorage 有 token → 直接渲染 children；无 token → 录入页。
 * 提交后调用 `window.desktop.healthCheck()` 校验；401 时 desktop-client 已清掉
 * localStorage 里的 token 并派发 `ai-novel:auth-required`——这里监听该事件，
 * 统一处理"提交失败"与"运行期 token 失效被踢回录入页"两种情况。
 */
export function TokenGate({ children }: TokenGateProps) {
  const [authorized, setAuthorized] = useState<boolean>(() => readStoredToken() !== null);
  const [tokenInput, setTokenInput] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isVerifying, setIsVerifying] = useState(false);

  useEffect(() => {
    function handleAuthRequired() {
      setAuthorized(false);
      setError(INVALID_TOKEN_MESSAGE);
    }
    window.addEventListener(AUTH_REQUIRED_EVENT, handleAuthRequired);
    return () => window.removeEventListener(AUTH_REQUIRED_EVENT, handleAuthRequired);
  }, []);

  const handleSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const trimmed = tokenInput.trim();
      if (trimmed.length === 0) {
        setError('请输入访问令牌');
        return;
      }

      setError(null);
      setIsVerifying(true);
      storeToken(trimmed);

      void window.desktop
        .healthCheck()
        .then(() => {
          setAuthorized(true);
          setTokenInput('');
        })
        .catch(() => {
          // 401 时 desktop-client 已清掉 localStorage 里的 token。
          setAuthorized(false);
          setError(INVALID_TOKEN_MESSAGE);
        })
        .finally(() => {
          setIsVerifying(false);
        });
    },
    [tokenInput],
  );

  if (authorized) {
    return <>{children}</>;
  }

  return (
    <div className="token-gate">
      <div className="token-gate-card">
        <h1 className="token-gate-title">AI 小说创作代理</h1>
        <p className="token-gate-description">请输入服务端启动日志中打印的访问令牌</p>
        <form className="token-gate-form" onSubmit={handleSubmit}>
          <div className="form-field">
            <label htmlFor="token-gate-input">访问令牌</label>
            <input
              id="token-gate-input"
              type="password"
              value={tokenInput}
              onChange={(event) => setTokenInput(event.target.value)}
              autoFocus
              autoComplete="off"
              disabled={isVerifying}
              aria-invalid={error ? 'true' : undefined}
              aria-describedby={error ? 'token-gate-error' : undefined}
            />
          </div>
          {error && (
            <span className="form-error" id="token-gate-error" role="alert">
              {error}
            </span>
          )}
          <button
            type="submit"
            className="btn-create"
            disabled={isVerifying}
            aria-busy={isVerifying}
          >
            {isVerifying ? '验证中…' : '进入'}
          </button>
        </form>
      </div>
    </div>
  );
}
