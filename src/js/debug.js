const PREFIX = '[VoxCall]';

export function dialLog(step, data) {
  const time = new Date().toISOString().split('T')[1].slice(0, 12);
  if (data !== undefined) {
    console.log(`${PREFIX} ${time} | ${step}`, data);
  } else {
    console.log(`${PREFIX} ${time} | ${step}`);
  }
}

export function dialGroup(label, fn) {
  console.group(`${PREFIX} ${label}`);
  try {
    return fn();
  } finally {
    console.groupEnd();
  }
}

export function dialError(step, error) {
  console.error(`${PREFIX} ${step}`, error);
}
