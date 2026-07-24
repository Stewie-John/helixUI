import React from 'react';
import { useAuth } from '../contexts/AuthContext';
import SetupForm from './SetupForm';
import LoginForm from './LoginForm';
import ForcedPasswordChange from './ForcedPasswordChange';
import Onboarding from './Onboarding';
import DNASpinner from './tech/DNASpinner';
import { IS_PLATFORM } from '../constants/config';

const LoadingScreen = () => (
  <div className="min-h-screen bg-background flex items-center justify-center p-4">
    <div className="text-center">
      {/* 统一浅蓝 DNA 旋转加载动画 */}
      <div className="flex justify-center mb-4">
        <DNASpinner size="md" />
      </div>
      <h1 className="text-2xl font-bold text-foreground mb-2">HelixUI</h1>
      <p className="text-muted-foreground mt-2">Loading...</p>
    </div>
  </div>
);

const ProtectedRoute = ({ children }) => {
  const { user, isLoading, needsSetup, hasCompletedOnboarding, refreshOnboardingStatus } = useAuth();

  if (IS_PLATFORM) {
    if (isLoading) {
      return <LoadingScreen />;
    }

    if (!hasCompletedOnboarding) {
      return <Onboarding onComplete={refreshOnboardingStatus} />;
    }

    return children;
  }

  if (isLoading) {
    return <LoadingScreen />;
  }

  if (needsSetup) {
    return <SetupForm />;
  }

  if (!user) {
    return <LoginForm />;
  }

  if (user.must_change_password) {
    return <ForcedPasswordChange />;
  }

  if (!hasCompletedOnboarding) {
    return <Onboarding onComplete={refreshOnboardingStatus} />;
  }

  return children;
};

export default ProtectedRoute;
