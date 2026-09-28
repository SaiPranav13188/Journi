import { Redirect } from 'expo-router';

// Deep-link target for the OAuth redirect (journi://auth/callback). The auth
// session itself is completed in AuthProvider; this just returns to the app.
export default function AuthCallback() {
  return <Redirect href="/" />;
}
