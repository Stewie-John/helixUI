// 管理员（id=1）专属：列出所有活跃账号、为新成员创建账号。
// 共享数据多账号场景下，此页面是唯一开账号入口（公开注册已关闭）。
import { useCallback, useEffect, useState } from 'react';
import { LockKeyhole, Users, UserPlus } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { api } from '../../../../../utils/api';
import { Button } from '../../../../ui/button';
import { Input } from '../../../../ui/input';
import { useAuth } from '../../../../../contexts/AuthContext';

type UserRow = {
  id: number;
  username: string;
  avatar_url: string | null;
};

type UsersSettingsTabProps = { isAdmin: boolean };

export default function UsersSettingsTab({ isAdmin }: UsersSettingsTabProps) {
  const { t } = useTranslation('settings');
  const { changePassword, revokeOtherSessions } = useAuth() as unknown as {
    changePassword: (currentPassword: string, newPassword: string) => Promise<{ success: boolean; error?: string }>;
    revokeOtherSessions: () => Promise<{ success: boolean; error?: string }>;
  };
  const [users, setUsers] = useState<UserRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [newUsername, setNewUsername] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [currentPassword, setCurrentPassword] = useState('');
  const [accountPassword, setAccountPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [changingPassword, setChangingPassword] = useState(false);
  const [securityError, setSecurityError] = useState<string | null>(null);
  const [securitySuccess, setSecuritySuccess] = useState(false);
  const [revokingSessions, setRevokingSessions] = useState(false);
  const [revokeError, setRevokeError] = useState<string | null>(null);
  const [revokeSuccess, setRevokeSuccess] = useState(false);

  const fetchUsers = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.user.listAvatars();
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data?.users)) {
          setUsers(data.users);
        }
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (isAdmin) fetchUsers();
  }, [fetchUsers, isAdmin]);

  const handleChangePassword = async (event: React.FormEvent) => {
    event.preventDefault();
    setSecurityError(null);
    setSecuritySuccess(false);
    if (accountPassword.length < 10) {
      setSecurityError(t('users.security.errors.passwordTooShort'));
      return;
    }
    if (accountPassword !== confirmPassword) {
      setSecurityError(t('users.security.errors.passwordMismatch'));
      return;
    }

    setChangingPassword(true);
    const result = await changePassword(currentPassword, accountPassword);
    setChangingPassword(false);
    if (!result.success) {
      setSecurityError(result.error || t('users.security.errors.failed'));
      return;
    }
    setCurrentPassword('');
    setAccountPassword('');
    setConfirmPassword('');
    setSecuritySuccess(true);
  };

  const handleRevokeOtherSessions = async () => {
    setRevokeError(null);
    setRevokeSuccess(false);
    setRevokingSessions(true);
    const result = await revokeOtherSessions();
    setRevokingSessions(false);
    if (!result.success) {
      setRevokeError(result.error || t('users.security.revoke.errors.failed'));
      return;
    }
    setRevokeSuccess(true);
  };

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSuccessMsg(null);

    if (newUsername.trim().length < 3) {
      setError(t('users.errors.usernameTooShort'));
      return;
    }
    if (newPassword.length < 10) {
      setError(t('users.errors.passwordTooShort'));
      return;
    }

    setSubmitting(true);
    try {
      const res = await api.auth.createUser(newUsername.trim(), newPassword);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data?.error || t('users.errors.createFailed'));
        return;
      }
      setSuccessMsg(t('users.success.created', { username: newUsername.trim() }));
      setNewUsername('');
      setNewPassword('');
      await fetchUsers();
    } catch {
      setError(t('users.errors.networkError'));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-8">
      <div>
        <div className="flex items-center gap-2 mb-4">
          <LockKeyhole className="h-5 w-5" />
          <h3 className="text-lg font-semibold">{t('users.security.title')}</h3>
        </div>
        <p className="text-sm text-muted-foreground mb-4">{t('users.security.description')}</p>
        <div className="p-4 border rounded-lg bg-card mb-4 space-y-3">
          <div>
            <h4 className="text-sm font-medium text-foreground">{t('users.security.revoke.title')}</h4>
            <p className="mt-1 text-xs text-muted-foreground">{t('users.security.revoke.description')}</p>
          </div>
          {revokeError && <p className="text-sm text-red-500">{revokeError}</p>}
          {revokeSuccess && <p className="text-sm text-green-500">{t('users.security.revoke.success')}</p>}
          <Button type="button" variant="outline" onClick={handleRevokeOtherSessions} disabled={revokingSessions}>
            {revokingSessions ? t('users.security.revoke.submitting') : t('users.security.revoke.submit')}
          </Button>
        </div>
        <form onSubmit={handleChangePassword} className="p-4 border rounded-lg bg-card space-y-3">
          <Input
            type="password"
            value={currentPassword}
            onChange={(event) => setCurrentPassword(event.target.value)}
            placeholder={t('users.security.currentPassword')}
            autoComplete="current-password"
            disabled={changingPassword}
          />
          <Input
            type="password"
            value={accountPassword}
            onChange={(event) => setAccountPassword(event.target.value)}
            placeholder={t('users.security.newPassword')}
            autoComplete="new-password"
            disabled={changingPassword}
          />
          <Input
            type="password"
            value={confirmPassword}
            onChange={(event) => setConfirmPassword(event.target.value)}
            placeholder={t('users.security.confirmPassword')}
            autoComplete="new-password"
            disabled={changingPassword}
          />
          {securityError && <p className="text-sm text-red-500">{securityError}</p>}
          {securitySuccess && <p className="text-sm text-green-500">{t('users.security.success')}</p>}
          <Button
            type="submit"
            disabled={changingPassword || !currentPassword || !accountPassword || !confirmPassword}
          >
            {changingPassword ? t('users.security.submitting') : t('users.security.submit')}
          </Button>
        </form>
      </div>

      {isAdmin && <>
      <div>
        <div className="flex items-center gap-2 mb-4">
          <Users className="h-5 w-5" />
          <h3 className="text-lg font-semibold">{t('users.title')}</h3>
        </div>

        <p className="text-sm text-muted-foreground mb-4">
          {t('users.description')}
        </p>

        <div className="p-4 border rounded-lg bg-card">
          <h4 className="text-sm font-medium mb-3">{t('users.list.title')}</h4>
          {loading ? (
            <p className="text-sm text-muted-foreground">{t('users.list.loading')}</p>
          ) : users.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('users.list.empty')}</p>
          ) : (
            <ul className="space-y-2">
              {users.map((u) => (
                <li
                  key={u.id}
                  className="flex items-center gap-3 px-3 py-2 rounded-md bg-background border border-border"
                >
                  {u.avatar_url ? (
                    <img
                      src={u.avatar_url}
                      alt={u.username}
                      className="w-8 h-8 rounded-full object-cover"
                    />
                  ) : (
                    <div className="w-8 h-8 rounded-full bg-muted flex items-center justify-center text-xs font-medium text-muted-foreground">
                      {u.username.slice(0, 1).toUpperCase()}
                    </div>
                  )}
                  <span className="text-sm font-medium text-foreground">{u.username}</span>
                  {u.id === 1 && (
                    <span className="ml-auto text-xs px-2 py-0.5 rounded-full bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300">
                      {t('users.list.adminBadge')}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <div>
        <div className="flex items-center gap-2 mb-4">
          <UserPlus className="h-5 w-5" />
          <h4 className="text-base font-semibold">{t('users.create.sectionTitle')}</h4>
        </div>

        <form onSubmit={handleCreate} className="p-4 border rounded-lg bg-card space-y-3">
          <div>
            <label htmlFor="new-user-username" className="block text-sm font-medium text-foreground mb-2">
              {t('users.create.usernameLabel')}
            </label>
            <Input
              id="new-user-username"
              type="text"
              value={newUsername}
              onChange={(e) => setNewUsername(e.target.value)}
              placeholder={t('users.create.usernamePlaceholder')}
              autoComplete="off"
              disabled={submitting}
              className="w-full"
            />
          </div>

          <div>
            <label htmlFor="new-user-password" className="block text-sm font-medium text-foreground mb-2">
              {t('users.create.passwordLabel')}
            </label>
            <Input
              id="new-user-password"
              type="text"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              placeholder={t('users.create.passwordPlaceholder')}
              autoComplete="off"
              disabled={submitting}
              className="w-full"
            />
            <p className="mt-1 text-xs text-muted-foreground">
              {t('users.create.passwordHint')}
            </p>
          </div>

          {error && (
            <div className="p-2 bg-red-100 dark:bg-red-900/20 border border-red-300 dark:border-red-800 rounded-md">
              <p className="text-sm text-red-700 dark:text-red-400">{error}</p>
            </div>
          )}
          {successMsg && (
            <div className="p-2 bg-green-100 dark:bg-green-900/20 border border-green-300 dark:border-green-800 rounded-md">
              <p className="text-sm text-green-700 dark:text-green-400">{successMsg}</p>
            </div>
          )}

          <div>
            <Button
              type="submit"
              disabled={submitting || !newUsername.trim() || !newPassword}
            >
              {submitting ? t('users.create.submitting') : t('users.create.submit')}
            </Button>
          </div>
        </form>
      </div>
      </>}
    </div>
  );
}
