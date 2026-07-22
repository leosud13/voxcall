const PREFIX = '[VoxCall SIP]';

export function sipLog(step, data) {
  const time = new Date().toISOString().split('T')[1].replace('Z', '');
  if (data === undefined) {
    console.log(`${PREFIX} ${time} ${step}`);
    return;
  }
  console.log(`${PREFIX} ${time} ${step}`, data);
}

export function sipError(step, error) {
  const time = new Date().toISOString().split('T')[1].replace('Z', '');
  console.error(`${PREFIX} ${time} ${step}`, error);
}
