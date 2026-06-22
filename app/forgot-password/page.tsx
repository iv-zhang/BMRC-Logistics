// app/forgot-password/page.tsx
'use client';
import React, { useState } from 'react';
import Link from 'next/link';
import { Button, Input, Card, CardBody, CardHeader } from '@heroui/react';
import { Mail, ArrowLeft } from 'lucide-react';
import { sendPasswordResetEmail } from 'firebase/auth';
import { FirebaseError } from 'firebase/app';
import { auth } from '@/firebase';

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

      await sendPasswordResetEmail(auth, email, actionCodeSettings);
      
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
    <div className="flex items-center justify-center min-h-screen bg-gradient-to-br from-indigo-50 to-blue-50 dark:from-slate-900 dark:to-slate-800 p-4">
      <Card className="w-full max-w-md p-4">
        <CardHeader className="flex flex-col gap-1 pb-4">
          <h1 className="text-2xl font-bold">Reset Password</h1>
          <p className="text-sm text-gray-500">
            Enter your email address and we&apos;ll send you a link to reset your password.
          </p>
        </CardHeader>
        
        <CardBody>
          {message && (
            <div className={`p-3 mb-4 text-sm rounded-lg ${
              message.type === 'success' 
                ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400' 
                : 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400'
            }`}>
              {message.text}
            </div>
          )}

          <form onSubmit={handleSubmit} className="flex flex-col gap-4">
            <Input
              autoFocus
              endContent={<Mail className="text-2xl text-default-400 pointer-events-none flex-shrink-0" />}
              label="Email"
              placeholder="Enter your email"
              type="email"
              variant="bordered"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              isRequired
            />
            
            <Button 
              color="primary" 
              type="submit" 
              isLoading={loading}
              className="w-full font-semibold"
            >
              {loading ? 'Sending Link...' : 'Send Reset Link'}
            </Button>
          </form>

          <div className="mt-4 text-center">
            <Link 
              href="/login" 
              className="inline-flex items-center text-sm text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-200 transition-colors"
            >
              <ArrowLeft className="w-4 h-4 mr-2" />
              Back to Sign In
            </Link>
          </div>
        </CardBody>
      </Card>
    </div>
  );
}
