import React, {Suspense} from 'react';
import {LoadingState} from '@/components/States';

function Layout({ children }: { children: React.ReactNode }) {
    return (
        <Suspense fallback={<LoadingState />}>
            {children}
        </Suspense>
    )
}

export default Layout;