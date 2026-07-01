import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { DeployUrl } from '@/features/deploy/DeployUrl';
import { TooltipProvider } from '@/shared/ui/tooltip';

// Tooltip requires a provider ancestor (rooted in App.tsx in the real app).
const renderWithProvider = (ui: React.ReactElement) =>
  render(<TooltipProvider>{ui}</TooltipProvider>);

describe('DeployUrl', () => {
  it('mutes the URL and shows the deploy hint when there is no production version', () => {
    renderWithProvider(<DeployUrl slug="demo" hasProduction={false} />);

    expect(screen.getByText('versions.deployHint')).toBeInTheDocument();
    // No clickable link: the URL is plain text (clicking would 404) and the
    // open-in-new-tab affordance is hidden.
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('renders the URL as a link and hides the hint when a production version exists', () => {
    renderWithProvider(<DeployUrl slug="demo" hasProduction={true} />);

    expect(screen.queryByText('versions.deployHint')).not.toBeInTheDocument();
    expect(screen.getAllByRole('link').length).toBeGreaterThan(0);
  });
});
