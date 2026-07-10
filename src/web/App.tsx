import { useCallback, useEffect, useState } from 'react';
import { ReviewDetail } from './ReviewDetail.js';
import { ReviewList } from './ReviewList.js';

/** Minimal path-based routing: "/review/:id" → detail, everything else → the list. */
export function App() {
  const [pathname, setPathname] = useState(window.location.pathname);

  useEffect(() => {
    const onPop = () => setPathname(window.location.pathname);
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const navigate = useCallback((to: string) => {
    window.history.pushState({}, '', to);
    setPathname(to);
  }, []);

  const match = pathname.match(/^\/review\/(\d+)/);
  return match ? <ReviewDetail reviewId={Number(match[1])} navigate={navigate} /> : <ReviewList navigate={navigate} />;
}
