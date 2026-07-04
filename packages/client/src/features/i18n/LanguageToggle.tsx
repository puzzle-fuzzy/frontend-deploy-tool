import { Globe } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';

export function LanguageToggle() {
  const { i18n } = useTranslation();
  const isZh = i18n.language.startsWith('zh');

  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={() => i18n.changeLanguage(isZh ? 'en' : 'zh')}
    >
      <Globe className="size-4" />
      <span className="ml-1 text-xs">{isZh ? 'EN' : '中'}</span>
    </Button>
  );
}
