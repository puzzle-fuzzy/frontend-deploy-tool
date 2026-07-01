/**
 * Frontend configuration
 * Supports both same-origin and cross-origin deployment scenarios
 */

// Get public base URL from environment variable or fall back to current origin
// This allows deployment to different domains/ports
const trimTrailingSlashes = (url: string): string => url.replace(/\/+$/, '');

export const getPublicBaseURL = (): string => {
  // Check if there's an environment variable set (import.meta.env for Vite)
  const envPublicURL = import.meta.env.VITE_PUBLIC_BASE_URL;
  if (envPublicURL) {
    return trimTrailingSlashes(envPublicURL);
  }

  // Fall back to current origin for same-origin deployments
  return trimTrailingSlashes(window.location.origin);
};

// Export a singleton instance
export const publicBaseURL = getPublicBaseURL();
