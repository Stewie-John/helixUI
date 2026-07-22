import React, { useState } from 'react';
import { LockKeyhole } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../contexts/AuthContext';

const ForcedPasswordChange = () => {
  const { t } = useTranslation('auth');
  const { user, changePassword, logout } = useAuth();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (event) => {
    event.preventDefault();
    setError('');
    if (newPassword.length < 10) {
      setError(t('forcedPassword.errors.tooShort'));
      return;
    }
    if (newPassword !== confirmPassword) {
      setError(t('forcedPassword.errors.mismatch'));
      return;
    }

    setSubmitting(true);
    const result = await changePassword(currentPassword, newPassword);
    setSubmitting(false);
    if (!result.success) setError(result.error || t('forcedPassword.errors.failed'));
  };

  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-4">
      <div className="w-full max-w-md bg-card border border-border rounded-lg shadow-lg p-8 space-y-6">
        <div className="text-center">
          <div className="mx-auto mb-4 w-14 h-14 rounded-lg bg-primary flex items-center justify-center">
            <LockKeyhole className="w-7 h-7 text-primary-foreground" />
          </div>
          <h1 className="text-2xl font-bold text-foreground">{t('forcedPassword.title')}</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {t('forcedPassword.description', { username: user?.username })}
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <input
            type="password"
            value={currentPassword}
            onChange={(event) => setCurrentPassword(event.target.value)}
            placeholder={t('forcedPassword.currentPassword')}
            autoComplete="current-password"
            disabled={submitting}
            className="w-full px-3 py-2 border border-border rounded-md bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-blue-500"
            required
          />
          <input
            type="password"
            value={newPassword}
            onChange={(event) => setNewPassword(event.target.value)}
            placeholder={t('forcedPassword.newPassword')}
            autoComplete="new-password"
            disabled={submitting}
            className="w-full px-3 py-2 border border-border rounded-md bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-blue-500"
            required
          />
          <input
            type="password"
            value={confirmPassword}
            onChange={(event) => setConfirmPassword(event.target.value)}
            placeholder={t('forcedPassword.confirmPassword')}
            autoComplete="new-password"
            disabled={submitting}
            className="w-full px-3 py-2 border border-border rounded-md bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-blue-500"
            required
          />

          {error && (
            <div className="p-3 bg-red-100 dark:bg-red-900/20 border border-red-300 dark:border-red-800 rounded-md">
              <p className="text-sm text-red-700 dark:text-red-400">{error}</p>
            </div>
          )}

          <button
            type="submit"
            disabled={submitting || !currentPassword || !newPassword || !confirmPassword}
            className="w-full bg-blue-600 hover:bg-blue-700 disabled:bg-blue-400 text-white font-medium py-2 px-4 rounded-md transition-colors"
          >
            {submitting ? t('forcedPassword.submitting') : t('forcedPassword.submit')}
          </button>
          <button
            type="button"
            onClick={logout}
            disabled={submitting}
            className="w-full text-sm text-muted-foreground hover:text-foreground"
          >
            {t('forcedPassword.logout')}
          </button>
        </form>
      </div>
    </div>
  );
};

export default ForcedPasswordChange;
