// app/forgot-password/page.tsx
'use client';
import React, { useState } from 'react';
import Link from 'next/link';
import { Button, Input } from '@heroui/react';
import { Mail, ArrowLeft } from 'lucide-react';
import { sendPasswordResetEmail } from 'firebase/auth';
import { FirebaseError } from 'firebase/app';
import { auth } from '@/firebase';
import AuthShell from '@/app/components/auth-shell';

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error', text: string } | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setMessage(null);

    try {
      // Configures the url to redirect back to after password reset (optional)
      const actionCodeSettings = {
        url: window.location.origin + '/login',
        handleCodeInApp: true,
      };

      await sendPasswordResetEmail(auth, email.trim(), actionCodeSettings);

      setMessage({
        type: 'success',
        text: 'Check your email for a link to reset your password. If it doesn\'t appear within a few minutes, check your spam folder.'
      });
      setEmail(''); // Clear input on success
    } catch (err: unknown) {
      console.error('Reset password error:', err);
      let errorMessage = 'Failed to send reset email. Please try again.';

      if (err instanceof FirebaseError) {
        switch (err.code) {
          case 'auth/invalid-email':
            errorMessage = 'Please enter a valid email address.';
            break;
          case 'auth/user-not-found':
            // For security, it is often better to show a generic success message
            // or the same message as success to prevent email enumeration,
            // but for development:
            errorMessage = 'No account found with this email.';
            break;
          case 'auth/too-many-requests':
            errorMessage = 'Too many requests. Please try again later.';
            break;
        }
      }
      setMessage({ type: 'error', text: errorMessage });
    } finally {
      setLoading(false);
    }
  };

  return (
    <AuthShell
      title="Reset password"
      subtitle="Enter your email address and we'll send you a link to reset your password."
    >
      {message && (
        <div className={`px-4 py-3 text-sm rounded-large border ${
          message.type === 'success'
            ? 'bg-success-50 dark:bg-success-950/20 border-success/30 text-success'
            : 'bg-danger-50 dark:bg-danger-950/20 border-danger/30 text-danger'
        }`}>
          {message.text}
        </div>
      )}

      <form onSubmit={handleSubmit} className="flex flex-col gap-5">
        <Input
          autoFocus
          endContent={<Mail className="text-2xl text-default-400 pointer-events-none flex-shrink-0" />}
          label="Email"
          placeholder="Enter your email"
          type="email"
          variant="bordered"
          size="lg"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          isRequired
        />

        <Button
          color="primary"
          type="submit"
          isLoading={loading}
          className="w-full h-12 font-semibold"
          size="lg"
        >
          {loading ? 'Sending Link...' : 'Send Reset Link'}
        </Button>
      </form>

      <div className="text-center">
        <Link
          href="/login"
          className="inline-flex items-center gap-2 text-sm text-foreground-500 hover:text-foreground transition-colors"
        >
          <ArrowLeft size={16} />
          Back to Sign In
        </Link>
      </div>
    </AuthShell>
  );
}
