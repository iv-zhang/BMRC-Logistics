'use client';
import React, { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Button, Input } from '@heroui/react';
import { EyeSlashFilledIcon, EyeFilledIcon } from '@heroui/shared-icons';
import { signInWithEmailAndPassword } from 'firebase/auth';
import { FirebaseError } from 'firebase/app';
import { auth } from '@/firebase';
import AuthShell from '@/app/components/auth-shell';

export default function LoginPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [isVisible, setIsVisible] = useState(false);
  const [error, setError] = useState('');
  const router = useRouter();

  const toggleVisibility = () => setIsVisible(!isVisible);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await signInWithEmailAndPassword(auth, email.trim(), password);
      router.push('/dashboard');
    } catch (err: unknown) {
      console.error('Login error:', err);
      if (err instanceof FirebaseError) {
        if (err.code === 'auth/invalid-credential') {
          setError('Invalid email or password');
        } else if (err.code === 'auth/user-not-found') {
          setError('User not found');
        } else if (err.code === 'auth/wrong-password') {
          setError('Wrong password');
        } else {
          setError(err.message || 'Failed to sign in');
        }
      } else {
        setError('Failed to sign in');
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <AuthShell title="Sign in" subtitle="Access your logistics dashboard">
      {error && (
        <div className="w-full px-4 py-3 bg-danger-50 dark:bg-danger-950/20 border border-danger/30 rounded-large">
          <p className="text-danger text-sm font-medium">{error}</p>
        </div>
      )}
      <form onSubmit={handleSubmit} className="flex flex-col gap-5">
        <Input
          type="email"
          label="Email"
          placeholder="Enter your email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          variant="bordered"
          size="lg"
          className="w-full"
        />
        <Input
          label="Password"
          placeholder="Enter your password"
          type={isVisible ? "text" : "password"}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          variant="bordered"
          size="lg"
          endContent={
            <button className="focus:outline-none" type="button" onClick={toggleVisibility}>
              {isVisible ? (
                <EyeSlashFilledIcon className="text-2xl text-default-400" />
              ) : (
                <EyeFilledIcon className="text-2xl text-default-400" />
              )}
            </button>
          }
        />
        <div className="flex justify-end -mt-2">
          <Link
            href="/forgot-password"
            className="text-sm text-primary hover:underline"
          >
            Forgot password?
          </Link>
        </div>
        <Button
          type="submit"
          isLoading={loading}
          color="primary"
          className="w-full h-12 font-semibold"
          size="lg"
        >
          {loading ? 'Signing in...' : 'Sign In'}
        </Button>
      </form>
      <div className="text-center text-sm">
        <p className="text-foreground-500">
          Don&apos;t have an account?{' '}
          <Link href="/register" className="text-primary font-semibold hover:underline">
            Register
          </Link>
        </p>
      </div>
    </AuthShell>
  );
}
