'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

import Image from 'next/image';

import { useAccount } from '@/components/account-provider';
import { cn, shortAddress, usd } from '@/lib/utils';

const LINKS = [
    { href: '/browse', label: 'Fleet' },
    { href: '/rentals', label: 'Rentals' },
    { href: '/wallet', label: 'Wallet' },
];

export default function NavBar() {
    const pathname = usePathname();
    const { session, balance, signOut } = useAccount();

    return (
        <nav className='px-14 py-16 flex items-center justify-between'>
            <section className='flex items-center gap-x-8'>
                <Link href='/' className='flex items-center gap-x-4'>
                    <Image src='/images/logo.svg' alt='logo' width={66} height={54} className='h-auto' priority />
                </Link>
                <ul className='flex items-center gap-x-6 text-secondary'>
                    {LINKS.map((link) => (
                        <li key={link.href}>
                            <Link
                                href={link.href}
                                className={cn(
                                    'transition-colors hover:text-foreground',
                                    pathname.startsWith(link.href) && 'text-foreground underline',
                                )}
                            >
                                {link.label}
                            </Link>
                        </li>
                    ))}
                </ul>
            </section>

            {session ? (
                <div className='px-3 py-2.5 flex items-center gap-x-3 border border-secondary rounded-lg'>
                    <Image src='/images/icons/energy.svg' alt='balance' width={32} height={32} className='h-auto' />
                    <div>
                        <h4 className='font-medium'>
                            {balance ? `${usd(balance.available)} USDC` : 'Loading...'}
                        </h4>
                        <h6 className='text-xs text-secondary'>
                            {shortAddress(session.depositAddress)} · {session.role}
                        </h6>
                    </div>
                    <button
                        className='ml-2 text-xs text-secondary underline cursor-pointer hover:text-foreground'
                        onClick={signOut}
                    >
                        Sign out
                    </button>
                </div>
            ) : (
                <Link href='/' className='px-3 py-2.5 border border-secondary rounded-lg text-secondary'>
                    Not signed in
                </Link>
            )}
        </nav>
    );
}
