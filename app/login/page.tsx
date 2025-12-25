'use client';
import React, { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Button, Input, Card, CardBody, CardHeader, Divider } from '@heroui/react';
import { EyeSlashFilledIcon, EyeFilledIcon } from '@heroui/shared-icons';
import { LogIn } from 'lucide-react';
import { signInWithEmailAndPassword } from 'firebase/auth';
import { FirebaseError } from 'firebase/app';
import { auth } from '@/firebase';

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
      await signInWithEmailAndPassword(auth, email, password);
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
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-indigo-50 to-blue-50 dark:from-slate-900 dark:to-slate-800 p-4">
      <Card className="max-w-md w-full shadow-lg bg-white/80 dark:bg-slate-800/80 border border-gray-200/70 dark:border-slate-700 rounded-xl">
        <CardHeader className="flex flex-col gap-2 p-6">
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white flex items-center gap-2">
            <LogIn className="text-indigo-600" size={22} />
            Sign in to BMRC
          </h1>
          <p className="text-gray-500 dark:text-gray-400 text-sm">Access your logistics dashboard</p>
        </CardHeader>
        <Divider />
        <CardBody className="p-8 gap-6">
          {error && (
            <div className="w-full p-4 bg-red-100 dark:bg-red-900/30 border-l-4 border-red-500 dark:border-red-600 rounded-2xl">
              <p className="text-red-700 dark:text-red-400 font-medium">{error}</p>
            </div>
          )}
          <form onSubmit={handleSubmit} className="space-y-6">
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
            <p className="text-gray-600 dark:text-gray-400">
              Don&apos;t have an account?{' '}
              <Link href="/register" className="text-indigo-600 dark:text-indigo-400 font-semibold hover:underline">
                Register
              </Link>
            </p>
          </div>
        </CardBody>
      </Card>
    </div>
  );
}
