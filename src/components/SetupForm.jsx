import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../contexts/AuthContext';

const SetupForm = () => {
  const { t } = useTranslation('auth');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [setupToken, setSetupToken] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');

  const { register, setupTokenRequired } = useAuth();

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');

    if (password !== confirmPassword) {
      setError(t('setup.errors.passwordMismatch'));
      return;
    }

    if (username.length < 3) {
      setError(t('setup.errors.usernameTooShort'));
      return;
    }

    // 与服务端 /api/auth/register 的下限保持一致，否则 6–9 位密码会被前端放行、
    // 再被服务端以另一套措辞拒绝。
    if (password.length < 10) {
      setError(t('setup.errors.passwordTooShort'));
      return;
    }

    setIsLoading(true);

    const result = await register(username, password, setupToken);

    if (!result.success) {
      setError(result.error);
    }
    
    setIsLoading(false);
  };

  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        <div className="bg-card rounded-lg shadow-lg border border-border p-8 space-y-6">
          {/* Logo and Title */}
          <div className="text-center">
            <div className="flex justify-center mb-4">
              <img src="/logo.svg" alt="HelixUI" className="w-16 h-16" />
            </div>
            <h1 className="text-2xl font-bold text-foreground">{t('setup.title')}</h1>
            <p className="text-muted-foreground mt-2">
              {t('setup.description')}
            </p>
          </div>

          {/* Setup Form */}
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label htmlFor="username" className="block text-sm font-medium text-foreground mb-1">
                {t('setup.username')}
              </label>
              <input
                type="text"
                id="username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                className="w-full px-3 py-2 border border-border rounded-md bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                placeholder={t('setup.placeholders.username')}
                autoComplete="username"
                minLength={3}
                maxLength={64}
                required
                disabled={isLoading}
              />
            </div>

            <div>
              <label htmlFor="password" className="block text-sm font-medium text-foreground mb-1">
                {t('setup.password')}
              </label>
              <input
                type="password"
                id="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full px-3 py-2 border border-border rounded-md bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                placeholder={t('setup.placeholders.password')}
                autoComplete="new-password"
                minLength={10}
                required
                disabled={isLoading}
              />
            </div>

            <div>
              <label htmlFor="confirmPassword" className="block text-sm font-medium text-foreground mb-1">
                {t('setup.confirmPassword')}
              </label>
              <input
                type="password"
                id="confirmPassword"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                className="w-full px-3 py-2 border border-border rounded-md bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                placeholder={t('setup.placeholders.confirmPassword')}
                autoComplete="new-password"
                minLength={10}
                required
                disabled={isLoading}
              />
            </div>

            {setupTokenRequired && (
              <div>
                <label htmlFor="setupToken" className="block text-sm font-medium text-foreground mb-1">
                  {t('setup.setupToken')}
                </label>
                <input
                  type="password"
                  id="setupToken"
                  value={setupToken}
                  onChange={(e) => setSetupToken(e.target.value)}
                  className="w-full px-3 py-2 border border-border rounded-md bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  placeholder={t('setup.placeholders.setupToken')}
                  autoComplete="off"
                  required
                  disabled={isLoading}
                />
                <p className="text-xs text-muted-foreground mt-1">
                  {t('setup.setupTokenHint')}
                </p>
              </div>
            )}

            {error && (
              <div role="alert" className="p-3 bg-red-100 dark:bg-red-900/20 border border-red-300 dark:border-red-800 rounded-md">
                <p className="text-sm text-red-700 dark:text-red-400">{error}</p>
              </div>
            )}

            <button
              type="submit"
              disabled={isLoading}
              className="w-full bg-blue-600 hover:bg-blue-700 disabled:bg-blue-400 text-white font-medium py-2 px-4 rounded-md transition-colors duration-200"
            >
              {isLoading ? t('setup.loading') : t('setup.submit')}
            </button>
          </form>

          <div className="text-center">
            <p className="text-sm text-muted-foreground">
              {t('setup.notice')}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
};

export default SetupForm;
