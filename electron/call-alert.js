const params = new URLSearchParams(window.location.search);
const caller = params.get('caller') || 'Desconhecido';
const number = params.get('number') || caller;

document.getElementById('caller').textContent = caller;
document.getElementById('number').textContent = number;

document.getElementById('btn-answer').addEventListener('click', () => {
  window.voxcallAlert?.answer?.();
});

document.getElementById('btn-reject').addEventListener('click', () => {
  window.voxcallAlert?.reject?.();
});
