import { LogOut } from 'lucide-react';
import { NavLink, Outlet, useNavigate, useParams } from 'react-router';

import { BrandMark } from '@/components/BrandMark';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useAuth } from '@/features/auth/auth-context';
import { useProject } from '@/features/projects/queries';
import { PROJECT_PAGES } from '@/features/projects/steps';
import type { User } from '@/lib/api-types';
import { cn } from '@/lib/utils';

const navItemClass =
  'flex h-9 w-full items-center rounded-md px-3 text-sm outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/50';

function navLinkClass({ isActive }: { isActive: boolean }): string {
  return cn(
    navItemClass,
    isActive
      ? 'bg-sidebar-accent font-medium text-sidebar-accent-foreground'
      : 'text-sidebar-foreground/80 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground',
  );
}

function initialsOf(name: string): string {
  const letters = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '');
  return letters.join('');
}

function UserMenu({ user }: { user: User }) {
  const { signOut } = useAuth();
  const navigate = useNavigate();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          className="h-auto w-full justify-start gap-2.5 px-2.5 py-2 text-left font-normal"
          aria-label={`Account menu for ${user.name}`}
        >
          <span
            aria-hidden="true"
            className="flex size-7 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium text-muted-foreground"
          >
            {initialsOf(user.name)}
          </span>
          <span className="min-w-0">
            <span className="block truncate text-sm font-medium">{user.name}</span>
            <span className="block truncate text-xs text-muted-foreground">{user.email}</span>
          </span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" className="w-56">
        <DropdownMenuLabel className="truncate text-xs font-normal text-muted-foreground">
          Signed in as {user.email}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={() => {
            void signOut().finally(() => {
              void navigate('/sign-in', { replace: true });
            });
          }}
        >
          <LogOut aria-hidden="true" />
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Sidebar (brand, current project, navigation, user menu) plus the main content area. */
export function AppShell() {
  const { user } = useAuth();
  const { projectId } = useParams();
  const project = useProject(projectId);
  const projectName = projectId ? (project.data?.name ?? '…') : 'No project open';

  return (
    <div className="min-h-screen bg-background">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded-md focus:bg-background focus:px-3 focus:py-2 focus:text-sm focus:shadow"
      >
        Skip to main content
      </a>
      <aside className="fixed inset-y-0 left-0 flex w-60 flex-col border-r bg-sidebar px-2.5 pt-5 pb-3 text-sidebar-foreground">
        <div className="px-2.5">
          <BrandMark />
        </div>
        <div className="mt-6 px-2.5">
          <p className="text-xs tracking-wide text-muted-foreground uppercase">Project</p>
          <p
            className={cn(
              'mt-0.5 truncate text-sm',
              projectId ? 'font-medium' : 'text-muted-foreground',
            )}
          >
            {projectName}
          </p>
        </div>
        <nav aria-label="Main" className="mt-4">
          <ul className="space-y-1">
            <li>
              <NavLink to="/projects" end className={navLinkClass}>
                Projects
              </NavLink>
            </li>
            {PROJECT_PAGES.map((page) => (
              <li key={page.slug}>
                {projectId ? (
                  <NavLink
                    to={`/projects/${encodeURIComponent(projectId)}/${page.slug}`}
                    className={navLinkClass}
                  >
                    {page.label}
                  </NavLink>
                ) : (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span
                        role="link"
                        aria-disabled="true"
                        tabIndex={0}
                        className={cn(navItemClass, 'cursor-not-allowed text-muted-foreground/70')}
                      >
                        {page.label}
                      </span>
                    </TooltipTrigger>
                    <TooltipContent side="right">Open a project first</TooltipContent>
                  </Tooltip>
                )}
              </li>
            ))}
          </ul>
        </nav>
        {user && (
          <div className="mt-auto">
            <UserMenu user={user} />
          </div>
        )}
      </aside>
      <main id="main" tabIndex={-1} className="ml-60 px-8 pt-7 pb-12 outline-none">
        <Outlet />
      </main>
    </div>
  );
}
