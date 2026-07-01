import { TooltipProvider } from '@/shared/ui/tooltip';
import { DeployPage } from './pages/DeployPage';
import { ToastProvider } from './shared/ui/toast';

export default function App() {
  return (
    <TooltipProvider>
      <ToastProvider>
        <DeployPage />
      </ToastProvider>
    </TooltipProvider>
  );
}
