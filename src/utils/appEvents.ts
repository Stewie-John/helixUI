export const PROJECTS_REFRESH_REQUESTED_EVENT = 'helix:projects-refresh-requested';
export const SETTINGS_UPDATED_EVENT = 'helix:settings-updated';
export const PROVIDER_UPDATED_EVENT = 'helix:provider-updated';

export const dispatchAppEvent = (eventName: string) => {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event(eventName));
  }
};

export const storeSelectedProvider = (provider: string) => {
  localStorage.setItem('selected-provider', provider);
  dispatchAppEvent(PROVIDER_UPDATED_EVENT);
};
