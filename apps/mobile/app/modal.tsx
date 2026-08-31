import { Redirect } from 'expo-router';

/** Legacy modal route; vault settings live under the Settings tab. */
export default function ModalScreen() {
  return <Redirect href="/two" />;
}
