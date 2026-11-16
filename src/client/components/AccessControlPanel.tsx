import React, { useState } from 'react';
import { PublicUser, UserRole } from '../../shared/types';
import { api, ApiClientError } from '../api';
import { formatUtcTimestamp } from './StatusText';

interface AccessControlPanelProps {
  users: PublicUser[];
  currentUser: PublicUser;
  onUpdated: () => Promise<void>;
}

const ROLES: UserRole[] = ['admin', 'operator', 'reviewer', 'viewer'];

export function AccessControlPanel({
  users,
  currentUser,
  onUpdated,
}: AccessControlPanelProps) {
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [role, setRole] = useState<UserRole>('operator');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);

  async function handleCreateUser(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    setFeedback(null);
    try {
      const res = await api.createUser({ email, displayName, role, password });
      setEmail('');
      setDisplayName('');
      setPassword('');
      await onUpdated();
      setFeedback(`Created user ${res.user.email} (${res.user.role}).`);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Failed to create user.');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleRoleChange(userId: string, nextRole: UserRole) {
    setBusyId(userId);
    setError(null);
    setFeedback(null);
    try {
      const res = await api.updateUserRole(userId, { role: nextRole });
      await onUpdated();
      setFeedback(`Updated ${res.user.email} role to ${res.user.role}.`);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Failed to update role.');
    } finally {
      setBusyId(null);
    }
  }

  async function handleActiveToggle(user: PublicUser) {
    setBusyId(user.id);
    setError(null);
    setFeedback(null);
    try {
      const res = await api.updateUserRole(user.id, { isActive: !user.isActive });
      await onUpdated();
      setFeedback(
        `${res.user.email} is now ${res.user.isActive ? 'active' : 'deactivated'}.`,
      );
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Failed to update user status.');
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-base font-semibold text-slate-900">Access Control &amp; Roles</h2>
        <p className="text-sm text-slate-600">
          Manage operator, reviewer, and viewer credentials enforced across all API routes.
        </p>
      </div>

      {error && (
        <div role="alert" className="p-3 border border-red-200 bg-red-50 rounded-md text-sm text-red-800">
          {error}
        </div>
      )}
      {feedback && (
        <div role="status" className="p-3 border border-slate-200 bg-white rounded-md text-sm text-slate-800">
          {feedback}
        </div>
      )}

      <form
        onSubmit={handleCreateUser}
        className="bg-white border border-slate-200 rounded-lg p-5 space-y-4"
      >
        <h3 className="text-sm font-semibold text-slate-900">Provision User Account</h3>
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <div>
            <label htmlFor="new-user-name" className="block text-xs font-medium text-slate-700 mb-1.5">
              Display name
            </label>
            <input
              id="new-user-name"
              type="text"
              required
              minLength={2}
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="Reviewer Name"
              className="w-full px-3 py-2 text-sm bg-white border border-slate-300 rounded-md text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-700"
            />
          </div>
          <div>
            <label htmlFor="new-user-email" className="block text-xs font-medium text-slate-700 mb-1.5">
              Email address
            </label>
            <input
              id="new-user-email"
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="reviewer@domain.com"
              className="w-full px-3 py-2 text-sm bg-white border border-slate-300 rounded-md text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-700"
            />
          </div>
          <div>
            <label htmlFor="new-user-role" className="block text-xs font-medium text-slate-700 mb-1.5">
              Role
            </label>
            <select
              id="new-user-role"
              value={role}
              onChange={(e) => setRole(e.target.value as UserRole)}
              className="w-full px-3 py-2 text-sm bg-white border border-slate-300 rounded-md text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-700"
            >
              {ROLES.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="new-user-password" className="block text-xs font-medium text-slate-700 mb-1.5">
              Initial password
            </label>
            <input
              id="new-user-password"
              type="password"
              required
              minLength={10}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Min 10 characters"
              className="w-full px-3 py-2 text-sm bg-white border border-slate-300 rounded-md text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-700"
            />
          </div>
        </div>
        <div className="flex justify-end">
          <button
            type="submit"
            disabled={submitting}
            className="px-4 py-2 text-sm font-medium text-white bg-blue-700 rounded-md hover:bg-blue-800 disabled:opacity-60 whitespace-nowrap"
          >
            {submitting ? 'Creating user...' : 'Create User'}
          </button>
        </div>
      </form>

      <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50 text-xs font-medium text-slate-600">
                <th className="py-3 px-4">User</th>
                <th className="py-3 px-4">Role</th>
                <th className="py-3 px-4">Status</th>
                <th className="py-3 px-4">Created</th>
                <th className="py-3 px-4 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 text-sm">
              {users.map((u) => {
                const isSelf = u.id === currentUser.id;
                const isBusy = busyId === u.id;
                return (
                  <tr key={u.id}>
                    <td className="py-3 px-4">
                      <div className="font-medium text-slate-900">
                        {u.displayName} {isSelf ? '(You)' : ''}
                      </div>
                      <div className="text-xs text-slate-500">{u.email}</div>
                    </td>
                    <td className="py-3 px-4">
                      <label htmlFor={`role-${u.id}`} className="sr-only">
                        Role for {u.email}
                      </label>
                      <select
                        id={`role-${u.id}`}
                        disabled={isBusy}
                        value={u.role}
                        onChange={(e) => handleRoleChange(u.id, e.target.value as UserRole)}
                        className="px-2.5 py-1 text-xs bg-white border border-slate-300 rounded-md text-slate-900"
                      >
                        {ROLES.map((r) => (
                          <option key={r} value={r}>
                            {r}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="py-3 px-4 text-xs text-slate-700">
                      {u.isActive ? 'Active' : 'Inactive'}
                    </td>
                    <td className="py-3 px-4 text-xs font-mono text-slate-500 whitespace-nowrap">
                      {formatUtcTimestamp(u.createdAt)}
                    </td>
                    <td className="py-3 px-4 text-right">
                      <button
                        type="button"
                        disabled={isBusy || isSelf}
                        onClick={() => handleActiveToggle(u)}
                        className="px-2.5 py-1 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-md hover:bg-slate-50 disabled:opacity-50 whitespace-nowrap"
                      >
                        {u.isActive ? 'Deactivate' : 'Reactivate'}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
