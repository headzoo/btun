import { Redirect } from 'expo-router';

/** Hidden legacy debug tab; primary IA is Vault + Settings. */
export default function FirebaseScreen() {
  return <Redirect href="/" />;
}
