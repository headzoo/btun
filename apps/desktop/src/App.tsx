import { AuthGate } from '@/components/AuthGate';
import { MainApp } from './MainApp';

function App() {
  return (
    <AuthGate>
      <MainApp />
    </AuthGate>
  );
}

export default App;
