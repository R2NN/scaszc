import { useEffect, useState } from 'react';

export function useDropdownPresence(open, duration = 180) {
  const [present, setPresent] = useState(open);
  const [visible, setVisible] = useState(open);

  useEffect(() => {
    let frameOne;
    let frameTwo;
    let timer;
    if (open) {
      setPresent(true);
      frameOne = requestAnimationFrame(() => {
        frameTwo = requestAnimationFrame(() => setVisible(true));
      });
    } else {
      setVisible(false);
      timer = window.setTimeout(() => setPresent(false), duration);
    }
    return () => {
      cancelAnimationFrame(frameOne);
      cancelAnimationFrame(frameTwo);
      clearTimeout(timer);
    };
  }, [open, duration]);

  return { present, visible };
}
