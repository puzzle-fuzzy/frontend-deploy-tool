import { TooltipProvider } from '@/components/ui/tooltip';
import { ToastProvider } from './lib/toast';
import { DeployPage } from './pages/DeployPage';

export default function App() {
  return (
    <TooltipProvider>
      <ToastProvider>
        <DeployPage />
      </ToastProvider>
    </TooltipProvider>
  );
}
