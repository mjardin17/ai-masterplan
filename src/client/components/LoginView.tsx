import React, { useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import { AuthStatusDTO, PublicUser } from '../../shared/types';
import { api, ApiClientError } from '../api';

interface LoginViewProps {
  authStatus: AuthStatusDTO;
  onAuthenticated: (user: PublicUser) => void;
}

export function LoginView({ authStatus, onAuthenticated }: LoginViewProps) {
  const isBootstrap = authStatus.bootstrapAvailable;
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      if (isBootstrap) {
        const res = await api.bootstrapAdmin({ email, displayName, password });
        onAuthenticated(res.user);
      } else {
        const res = await api.login({ email, password });
        onAuthenticated(res.user);
      }
    } catch (err) {
      if (err instanceof ApiClientError) {
        setError(err.message);
      } else {
        setError('Unable to reach authentication service.');
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="min-h-screen bg-slate-50 flex items-center justify-center px-4 py-12">
      <div className="w-full max-w-md bg-white border border-slate-200 rounded-lg p-8">
        <div className="flex items-center gap-2.5 text-slate-900 mb-2">
          <ShieldCheck className="w-5 h-5 text-blue-700 shrink-0" aria-hidden="true" />
          <h1 className="text-xl font-semibold tracking-tight">AI Masterplan</h1>
        </div>
        <p className="text-sm text-slate-600 mb-6">
          {isBootstrap
            ? 'Initial control plane setup. Create the first administrator account in SQLite.'
            : 'Sign in with your operator credentials to access the control plane.'}
        </p>

        {error && (
          <div
            role="alert"
            className="mb-5 p-3 border border-red-200 bg-red-50 rounded-md text-sm text-red-800"
          >
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          {isBootstrap && (
            <div>
              <label
                htmlFor="bootstrap-display-name"
                className="block text-sm font-medium text-slate-700 mb-1.5"
              >
                Administrator name
              </label>
              <input
                id="bootstrap-display-name"
                type="text"
                required
                minLength={2}
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder="Primary Administrator"
                className="w-full px-3 py-2 text-sm bg-white border border-slate-300 rounded-md text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-700"
              />
            </div>
          )}

          <div>
            <label
              htmlFor="auth-email"
              className="block text-sm font-medium text-slate-700 mb-1.5"
            >
              Email address
            </label>
            <input
              id="auth-email"
              type="email"
              required
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="operator@domain.com"
              className="w-full px-3 py-2 text-sm bg-white border border-slate-300 rounded-md text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-700"
            />
          </div>

          <div>
            <label
              htmlFor="auth-password"
              className="block text-sm font-medium text-slate-700 mb-1.5"
            >
              Password
            </label>
            <input
              id="auth-password"
              type="password"
              required
              minLength={isBootstrap ? 10 : 1}
              autoComplete={isBootstrap ? 'new-password' : 'current-password'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={isBootstrap ? 'Minimum 10 characters' : 'Enter password'}
              className="w-full px-3 py-2 text-sm bg-white border border-slate-300 rounded-md text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-700"
            />
          </div>

          <button
            type="submit"
            disabled={submitting}
            className="w-full px-4 py-2.5 text-sm font-medium text-white bg-blue-700 rounded-md hover:bg-blue-800 disabled:opacity-60 transition-colors whitespace-nowrap"
          >
            {submitting
              ? isBootstrap
                ? 'Creating administrator...'
                : 'Signing in...'
              : isBootstrap
                ? 'Initialize Administrator'
                : 'Sign In'}
          </button>
        </form>

        <p className="mt-6 pt-4 border-t border-slate-200 text-xs text-slate-500">
          {isBootstrap
            ? 'Bootstrap locks permanently after the first administrator is created.'
            : 'Sessions are backed by SQLite with HttpOnly cookies and immutable audit logging.'}
        </p>
      </div>
    </main>
  );
}
