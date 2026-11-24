const rentalForm = document.querySelector('#rental-form');
const researchBrief = document.querySelector('#research-brief');
const paymentButton = document.querySelector('#open-payment');
const paymentDialog = document.querySelector('#payment-dialog');
const paymentOptions = document.querySelector('#payment-options');
const paymentChoice = document.querySelector('#payment-choice');
const referenceImage = document.querySelector('#reference-image');
const paymentProof = document.querySelector('#payment-proof');
const rentButton = document.querySelector('#rent-now');
const trackingDialog = document.querySelector('#tracking-dialog');
const trackingId = document.querySelector('#tracking-id');

const imageInputs = [
  { input: referenceImage, error: document.querySelector('#reference-error') },
  { input: paymentProof, error: document.querySelector('#proof-error') }
];
const allowedImageTypes = ['image/jpeg', 'image/png', 'image/webp'];
const maxImageBytes = 5_000_000;

for (const { input, error } of imageInputs) {
  input.addEventListener('change', () => {
    const file = input.files[0];
    let message = '';
    if (file && !allowedImageTypes.includes(file.type)) {
      message = 'Choose a JPG, PNG, or WebP image.';
    } else if (file && (file.size === 0 || file.size > maxImageBytes)) {
      message = 'Choose an image greater than 0 bytes and up to 5 MB.';
    }

    input.setCustomValidity(message);
    error.textContent = message;
    rentButton.disabled = paymentProof.disabled || !paymentProof.validity.valid;
  });
}

paymentButton.addEventListener('click', () => {
  const briefIsValid = Array.from(researchBrief.elements).every(field => field.reportValidity());
  if (briefIsValid) {
    paymentDialog.showModal();
  }
});

paymentOptions.addEventListener('submit', event => {
  if (event.submitter?.value !== 'continue') {
    return;
  }

  const method = new FormData(paymentOptions).get('payment_method');
  paymentChoice.textContent = `Selected for preview: ${method}`;
  paymentProof.disabled = false;
  rentButton.disabled = !paymentProof.validity.valid;
});

paymentDialog.addEventListener('close', () => {
  if (paymentDialog.returnValue === 'continue') {
    paymentProof.focus();
  }
  paymentDialog.returnValue = '';
});

rentalForm.addEventListener('submit', event => {
  event.preventDefault();
  if (rentButton.disabled) {
    return;
  }

  const random = crypto.getRandomValues(new Uint8Array(8));
  const code = Array.from(random, byte => byte.toString(16).padStart(2, '0')).join('').toUpperCase();
  trackingId.textContent = `DEMO-${code}`;
  trackingDialog.showModal();
});

paymentButton.disabled = typeof paymentDialog.showModal !== 'function';
