import type { Metadata } from 'next';
import localFont from 'next/font/local';

import { AccountProvider } from '@/components/account-provider';

import './globals.css';

const styreneA = localFont({
    src: [
        { path: '../../public/fonts/StyreneA-Regular.ttf', weight: '400' },
        { path: '../../public/fonts/StyreneA-Medium.ttf', weight: '500' },
        { path: '../../public/fonts/StyreneA-Bold.ttf', weight: '700' },
    ],
    fallback: ['ui-sans-serif', 'system-ui', 'sans-serif'],
});

export const metadata: Metadata = {
    title: 'Robot Rental',
    description: 'Rent warehouse robots by the minute, settled in USDC on Arc',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
    return (
        <html lang='en'>
            <body className={`${styreneA.className} antialiased`}>
                <AccountProvider>{children}</AccountProvider>
            </body>
        </html>
    );
}
