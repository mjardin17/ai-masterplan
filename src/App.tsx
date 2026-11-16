import { useCallback, useEffect, useState } from 'react';
import {
  Activity,
  Bot,
  CheckSquare,
  FileText,
  LogOut,
  Menu,
  RefreshCw,
  Shield,
  Trophy,
  Users,
  X,
} from 'lucide-react';
import {
  ApprovalRequestDTO,
  AuditChainVerification,
  AuditLogDTO,
  AuthStatusDTO,
  BenchmarkTaskDTO,
  CompetitionDTO,
  ContestantDTO,
  HealthSummary,
  LeaderboardRowDTO,
  LearningObservationDTO,
  PublicUser,
} from './shared/types';
import { api, ApiClientError } from './client/api';
import { AccessControlPanel } from './client/components/AccessControlPanel';
import { ApprovalsPanel } from './client/components/ApprovalsPanel';
import { ArenaPanel } from './client/components/ArenaPanel';
import { AuditLogPanel } from './client/components/AuditLogPanel';
import { ContestantsPanel } from './client/components/ContestantsPanel';
import { LoginView } from './client/components/LoginView';
import { OverviewPanel } from './client/components/OverviewPanel';

type NavTab = 'overview' | 'arena' | 'contestants' | 'approvals' | 'audit' | 'access';

const TAB_LABELS: Record<NavTab, string> = {
  overview: 'Command Overview',
  arena: 'Competition Arena',
  contestants: 'Contestant Registry',
  approvals: 'Human Approvals',
  audit: 'Immutable Audit Log',
  access: 'Access Control',
};

export default function App() {
  const [authStatus, setAuthStatus] = useState<AuthStatusDTO | null>(null);
  const [loadingAuth, setLoadingAuth] = useState(true);
  const [activeTab, setActiveTab] = useState<NavTab>('overview');
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  const [health, setHealth] = useState<HealthSummary | null>(null);
  const [contestants, setContestants] = useState<ContestantDTO[]>([]);
  const [approvals, setApprovals] = useState<ApprovalRequestDTO[]>([]);
  const [auditEntries, setAuditEntries] = useState<AuditLogDTO[]>([]);
  const [auditTotal, setAuditTotal] = useState(0);
  const [auditVerification, setAuditVerification] = useState<AuditChainVerification | null>(null);
  const [users, setUsers] = useState<PublicUser[]>([]);
  const [arenaTasks, setArenaTasks] = useState<BenchmarkTaskDTO[]>([]);
  const [competitions, setCompetitions] = useState<CompetitionDTO[]>([]);
  const [leaderboard, setLeaderboard] = useState<LeaderboardRowDTO[]>([]);
  const [observations, setObservations] = useState<LearningObservationDTO[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const loadWorkspaceData = useCallback(async (user: PublicUser) => {
    setRefreshing(true);
    setLoadError(null);
    try {
      const [h, c, a, aud, t, comp, lb, obs] = await Promise.all([
        api.getHealth(),
        api.listContestants(),
        api.listApprovals(),
        api.listAuditLogs({ limit: 50 }),
        api.listArenaTasks(),
        api.listCompetitions(),
        api.getLeaderboard(),
        api.listObservations(),
      ]);
      setHealth(h);
      setContestants(c.contestants);
      setApprovals(a.approvals);
      setAuditEntries(aud.entries);
      setAuditTotal(aud.total);
      setAuditVerification(aud.verification);
      setArenaTasks(t.tasks);
      setCompetitions(comp.competitions);
      setLeaderboard(lb.leaderboard);
      setObservations(obs.observations);

      if (user.role === 'admin') {
        const u = await api.listUsers();
        setUsers(u.users);
      } else {
        setUsers([]);
      }
    } catch (err) {
      setLoadError(
        err instanceof ApiClientError ? err.message : 'Failed to load control plane data.',
      );
    } finally {
      setRefreshing(false);
    }
  }, []);

  const checkSession = useCallback(async () => {
    setLoadingAuth(true);
    try {
      const status = await api.getAuthStatus();
      setAuthStatus(status);
      if (status.authenticated && status.user) {
        await loadWorkspaceData(status.user);
      }
    } catch (err) {
      setLoadError(
        err instanceof ApiClientError ? err.message : 'Unable to reach AI Masterplan backend.',
      );
    } finally {
      setLoadingAuth(false);
    }
  }, [loadWorkspaceData]);

  useEffect(() => {
    void checkSession();
  }, [checkSession]);

  async function handleAuthenticated(user: PublicUser) {
    setAuthStatus({
      initialized: true,
      bootstrapAvailable: false,
      authenticated: true,
      user,
    });
    setActiveTab('overview');
    await loadWorkspaceData(user);
  }

  async function handleLogout() {
    await api.logout();
    setHealth(null);
    setContestants([]);
    setApprovals([]);
    setAuditEntries([]);
    setUsers([]);
    setArenaTasks([]);
    setCompetitions([]);
    setLeaderboard([]);
    setObservations([]);
    await checkSession();
  }

  async function handleAuditFilter(filters: { action?: string; resourceType?: string }) {
    const res = await api.listAuditLogs({ ...filters, limit: 50 });
    setAuditEntries(res.entries);
    setAuditTotal(res.total);
    setAuditVerification(res.verification);
  }

  if (loadingAuth) {
    return (
      <main className="min-h-screen bg-slate-50 flex items-center justify-center p-6">
        <div className="text-sm text-slate-600">Connecting to AI Masterplan control plane...</div>
      </main>
    );
  }

  if (!authStatus || !authStatus.authenticated || !authStatus.user) {
    return (
      <LoginView
        authStatus={
          authStatus ?? {
            initialized: true,
            bootstrapAvailable: false,
            authenticated: false,
            user: null,
          }
        }
        onAuthenticated={handleAuthenticated}
      />
    );
  }

  const currentUser = authStatus.user;

  const navItems: { id: NavTab; label: string; icon: typeof Activity; adminOnly?: boolean }[] = [
    { id: 'overview', label: 'Overview', icon: Activity },
    { id: 'arena', label: 'Arena', icon: Trophy },
    { id: 'contestants', label: 'Contestants', icon: Bot },
    { id: 'approvals', label: 'Approvals', icon: CheckSquare },
    { id: 'audit', label: 'Audit Log', icon: FileText },
    { id: 'access', label: 'Access Control', icon: Users, adminOnly: true },
  ];

  const visibleNav = navItems.filter((item) => !item.adminOnly || currentUser.role === 'admin');

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 flex flex-col md:flex-row">
      {/* Desktop Sidebar */}
      <aside className="hidden md:flex md:w-64 md:flex-col md:fixed md:inset-y-0 bg-white border-r border-slate-200">
        <div className="h-14 px-5 border-b border-slate-200 flex items-center gap-2.5">
          <Shield className="w-5 h-5 text-blue-700 shrink-0" aria-hidden="true" />
          <span className="font-semibold text-slate-900 tracking-tight whitespace-nowrap">
            AI Masterplan
          </span>
        </div>

        <nav aria-label="Primary navigation" className="flex-1 p-3 space-y-1">
          {visibleNav.map((item) => {
            const Icon = item.icon;
            const active = activeTab === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => setActiveTab(item.id)}
                aria-current={active ? 'page' : undefined}
                className={`w-full flex items-center gap-2.5 px-3 py-2 text-sm font-medium rounded-md transition-colors whitespace-nowrap ${
                  active
                    ? 'bg-blue-50 text-blue-800'
                    : 'text-slate-600 hover:text-slate-900 hover:bg-slate-100'
                }`}
              >
                <Icon className="w-4 h-4 shrink-0" aria-hidden="true" />
                {item.label}
              </button>
            );
          })}
        </nav>

        <div className="p-4 border-t border-slate-200 space-y-3">
          <div className="text-xs">
            <div className="font-medium text-slate-900 truncate">{currentUser.displayName}</div>
            <div className="text-slate-500 truncate">
              {currentUser.email} · {currentUser.role}
            </div>
          </div>
          <button
            type="button"
            onClick={handleLogout}
            className="w-full flex items-center justify-center gap-2 px-3 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-md hover:bg-slate-50 whitespace-nowrap"
          >
            <LogOut className="w-3.5 h-3.5" aria-hidden="true" />
            Sign Out
          </button>
        </div>
      </aside>

      {/* Mobile Navigation Drawer */}
      {mobileMenuOpen && (
        <div className="fixed inset-0 z-40 md:hidden flex">
          <div
            className="fixed inset-0 bg-slate-900/40"
            onClick={() => setMobileMenuOpen(false)}
          />
          <aside className="relative z-50 w-64 max-w-full bg-white h-full border-r border-slate-200 flex flex-col">
            <div className="h-14 px-4 border-b border-slate-200 flex items-center justify-between">
              <span className="font-semibold text-slate-900">AI Masterplan</span>
              <button
                type="button"
                aria-label="Close navigation menu"
                onClick={() => setMobileMenuOpen(false)}
                className="p-2 text-slate-600 hover:text-slate-900"
              >
                <X className="w-5 h-5" aria-hidden="true" />
              </button>
            </div>
            <nav aria-label="Mobile navigation" className="flex-1 p-3 space-y-1">
              {visibleNav.map((item) => {
                const Icon = item.icon;
                const active = activeTab === item.id;
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => {
                      setActiveTab(item.id);
                      setMobileMenuOpen(false);
                    }}
                    className={`w-full flex items-center gap-2.5 px-3 py-2 text-sm font-medium rounded-md ${
                      active ? 'bg-blue-50 text-blue-800' : 'text-slate-600 hover:bg-slate-100'
                    }`}
                  >
                    <Icon className="w-4 h-4 shrink-0" aria-hidden="true" />
                    {item.label}
                  </button>
                );
              })}
            </nav>
            <div className="p-4 border-t border-slate-200">
              <button
                type="button"
                onClick={handleLogout}
                className="w-full flex items-center justify-center gap-2 px-3 py-2 text-xs font-medium text-slate-700 border border-slate-300 rounded-md"
              >
                <LogOut className="w-3.5 h-3.5" aria-hidden="true" />
                Sign Out
              </button>
            </div>
          </aside>
        </div>
      )}

      {/* Main Content Area */}
      <div className="flex-1 md:pl-64 flex flex-col min-w-0">
        <header className="h-14 bg-white border-b border-slate-200 px-4 sm:px-6 flex items-center justify-between gap-4 sticky top-0 z-20">
          <div className="flex items-center gap-3 min-w-0">
            <button
              type="button"
              aria-label="Open navigation menu"
              onClick={() => setMobileMenuOpen(true)}
              className="md:hidden p-1.5 text-slate-600 hover:text-slate-900 rounded-md"
            >
              <Menu className="w-5 h-5" aria-hidden="true" />
            </button>
            <h1 className="text-sm font-semibold text-slate-900 truncate">
              Control Plane / {TAB_LABELS[activeTab]}
            </h1>
          </div>

          <div className="flex items-center gap-4 shrink-0">
            <span className="hidden sm:inline text-xs text-slate-500 whitespace-nowrap">
              {currentUser.displayName} · {currentUser.role}
            </span>
            <button
              type="button"
              disabled={refreshing}
              onClick={() => loadWorkspaceData(currentUser)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-md hover:bg-slate-50 disabled:opacity-50 whitespace-nowrap shrink-0"
            >
              <RefreshCw
                className={`w-3.5 h-3.5 ${refreshing ? 'animate-spin' : ''}`}
                aria-hidden="true"
              />
              Refresh
            </button>
          </div>
        </header>

        <main className="flex-1 p-4 sm:p-6 lg:p-8 max-w-[1200px] w-full mx-auto">
          {loadError && (
            <div
              role="alert"
              className="mb-6 p-3 border border-red-200 bg-red-50 rounded-md text-sm text-red-800"
            >
              {loadError}
            </div>
          )}

          {activeTab === 'overview' && (
            <OverviewPanel
              health={health}
              contestants={contestants}
              approvals={approvals}
              recentAudits={auditEntries}
              arenaTasksCount={arenaTasks.length}
              competitions={competitions}
              onNavigate={(tab) => setActiveTab(tab)}
            />
          )}

          {activeTab === 'arena' && (
            <ArenaPanel
              tasks={arenaTasks}
              competitions={competitions}
              leaderboard={leaderboard}
              observations={observations}
              contestants={contestants}
              userRole={currentUser.role}
              onUpdated={() => loadWorkspaceData(currentUser)}
            />
          )}

          {activeTab === 'contestants' && (
            <ContestantsPanel
              contestants={contestants}
              userRole={currentUser.role}
              onUpdated={() => loadWorkspaceData(currentUser)}
            />
          )}

          {activeTab === 'approvals' && (
            <ApprovalsPanel
              approvals={approvals}
              userRole={currentUser.role}
              onUpdated={() => loadWorkspaceData(currentUser)}
            />
          )}

          {activeTab === 'audit' && (
            <AuditLogPanel
              entries={auditEntries}
              total={auditTotal}
              verification={auditVerification}
              onFilter={handleAuditFilter}
            />
          )}

          {activeTab === 'access' && currentUser.role === 'admin' && (
            <AccessControlPanel
              users={users}
              currentUser={currentUser}
              onUpdated={() => loadWorkspaceData(currentUser)}
            />
          )}
        </main>
      </div>
    </div>
  );
}
