import React, { createContext, useContext, useEffect, useState } from 'react';
import { AUTH_TOKEN_INVALID_EVENT, api } from '../utils/api';
import { IS_PLATFORM } from '../constants/config';

const AuthContext = createContext({
  user: null,
  token: null,
  login: () => {},
  register: () => {},
  logout: () => {},
  changePassword: () => {},
  revokeOtherSessions: () => {},
  updateUser: () => {},
  isLoading: true,
  needsSetup: false,
  hasCompletedOnboarding: true,
  refreshOnboardingStatus: () => {},
  error: null
});

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};

export const AuthProvider = ({ children }) => {
  const [user, setUser] = useState(null);
  const [token, setToken] = useState(localStorage.getItem('auth-token'));
  const [isLoading, setIsLoading] = useState(true);
  const [needsSetup, setNeedsSetup] = useState(false);
  const [hasCompletedOnboarding, setHasCompletedOnboarding] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    const handleInvalidToken = () => {
      localStorage.removeItem('auth-token');
      setToken(null);
      setUser(null);
    };
    window.addEventListener(AUTH_TOKEN_INVALID_EVENT, handleInvalidToken);
    return () => window.removeEventListener(AUTH_TOKEN_INVALID_EVENT, handleInvalidToken);
  }, []);

  useEffect(() => {
    if (IS_PLATFORM) {
      setUser({ username: 'platform-user' });
      setNeedsSetup(false);
      checkOnboardingStatus();
      setIsLoading(false);
      return;
    }

    checkAuthStatus();
  }, []);

  const checkOnboardingStatus = async () => {
    try {
      const response = await api.user.onboardingStatus();
      if (response.ok) {
        const data = await response.json();
        setHasCompletedOnboarding(data.hasCompletedOnboarding);
      }
    } catch (error) {
      console.error('Error checking onboarding status:', error);
      setHasCompletedOnboarding(true);
    }
  };

  const refreshOnboardingStatus = async () => {
    await checkOnboardingStatus();
  };

  const checkAuthStatus = async () => {
    try {
      setIsLoading(true);
      setError(null);

      if (token) {
        // 有 token 时并行请求 status + user，减少串行等待
        const [statusResponse, userResponse] = await Promise.all([
          api.auth.status(),
          api.auth.user(),
        ]);
        const statusData = await statusResponse.json();

        if (statusData.needsSetup) {
          setNeedsSetup(true);
          setIsLoading(false);
          return;
        }

        if (userResponse.ok) {
          const userData = await userResponse.json();
          setUser(userData.user);
          setNeedsSetup(false);
          // onboardingStatus 不阻塞首屏渲染，后台异步加载
          checkOnboardingStatus();
        } else {
          localStorage.removeItem('auth-token');
          setToken(null);
          setUser(null);
        }
      } else {
        // 无 token 时只需检查 setup 状态
        const statusResponse = await api.auth.status();
        const statusData = await statusResponse.json();
        if (statusData.needsSetup) {
          setNeedsSetup(true);
        }
      }
    } catch (error) {
      console.error('[AuthContext] Auth status check failed:', error);
      setError('Failed to check authentication status');
    } finally {
      setIsLoading(false);
    }
  };

  const login = async (username, password) => {
    try {
      setError(null);
      const response = await api.auth.login(username, password);

      const data = await response.json();

      if (response.ok) {
        setToken(data.token);
        setUser(data.user);
        localStorage.setItem('auth-token', data.token);
        return { success: true };
      } else {
        setError(data.error || 'Login failed');
        return { success: false, error: data.error || 'Login failed' };
      }
    } catch (error) {
      console.error('Login error:', error);
      const errorMessage = 'Network error. Please try again.';
      setError(errorMessage);
      return { success: false, error: errorMessage };
    }
  };

  const register = async (username, password) => {
    try {
      setError(null);
      const response = await api.auth.register(username, password);

      const data = await response.json();

      if (response.ok) {
        setToken(data.token);
        setUser(data.user);
        setNeedsSetup(false);
        localStorage.setItem('auth-token', data.token);
        return { success: true };
      } else {
        setError(data.error || 'Registration failed');
        return { success: false, error: data.error || 'Registration failed' };
      }
    } catch (error) {
      console.error('Registration error:', error);
      const errorMessage = 'Network error. Please try again.';
      setError(errorMessage);
      return { success: false, error: errorMessage };
    }
  };

  // 局部 patch 当前 user（如头像更新后由 useUserAvatar 调用，无需整页刷新）
  const updateUser = (patch) => {
    setUser((prev) => (prev ? { ...prev, ...patch } : prev));
  };

  const logout = () => {
    setToken(null);
    setUser(null);
    localStorage.removeItem('auth-token');
    
    // Optional: Call logout endpoint for logging
    if (token) {
      api.auth.logout().catch(error => {
        console.error('Logout endpoint error:', error);
      });
    }
  };

  const changePassword = async (currentPassword, newPassword) => {
    try {
      const response = await api.auth.changePassword(currentPassword, newPassword);
      const data = await response.json().catch(() => ({}));
      if (!response.ok) return { success: false, error: data.error || 'Failed to change password' };

      localStorage.setItem('auth-token', data.token);
      setToken(data.token);
      if (data.user) setUser(data.user);
      return { success: true };
    } catch (changeError) {
      console.error('Change password error:', changeError);
      return { success: false, error: 'Network error. Please try again.' };
    }
  };

  const revokeOtherSessions = async () => {
    try {
      const response = await api.auth.revokeOtherSessions();
      const data = await response.json().catch(() => ({}));
      if (!response.ok) return { success: false, error: data.error || 'Failed to sign out other devices' };

      localStorage.setItem('auth-token', data.token);
      setToken(data.token);
      if (data.user) setUser(data.user);
      return { success: true };
    } catch (revokeError) {
      console.error('Revoke other sessions error:', revokeError);
      return { success: false, error: 'Network error. Please try again.' };
    }
  };

  const value = {
    user,
    token,
    login,
    register,
    logout,
    changePassword,
    revokeOtherSessions,
    updateUser,
    isLoading,
    needsSetup,
    hasCompletedOnboarding,
    refreshOnboardingStatus,
    error
  };

  return (
    <AuthContext.Provider value={value}>
      {children}
    </AuthContext.Provider>
  );
};
