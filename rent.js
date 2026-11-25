const rentalForm = document.querySelector('#rental-form');
const checkoutApi = document.querySelector('meta[name="rental-checkout-api"]')?.content;
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
    if (!checkoutApi) {
      rentButton.disabled = paymentProof.disabled || !paymentProof.validity.valid;
    }
  });
}

function setupPreview() {
  for (const element of document.querySelectorAll('[data-preview-only]')) {
    element.hidden = false;
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
}

function isStripeCheckout(url) {
  return typeof url === 'string' && url.startsWith('https://checkout.stripe.com/');
}

function setupStripeCheckout() {
  const notice = document.querySelector('#checkout-status');
  const resumeLink = document.querySelector('#resume-checkout');
  const resumeSolana = document.querySelector('#resume-solana');
  const paymentMethods = document.querySelector('#live-payment-methods');
  const solanaDialog = document.querySelector('#solana-dialog');
  const solanaVerify = document.querySelector('#solana-verify');
  const solanaStatus = document.querySelector('#solana-status');
  const browserStorageKey = 'rent-a-kitten-checkout';
  let requestId;
  let solanaRequestId;
  let solanaPoll;
  let solanaChecks = 0;
  let checkingSolana = false;

  for (const element of document.querySelectorAll('[data-live-only]')) {
    element.hidden = false;
  }
  document.querySelector('#email-help').textContent = 'Use the email address you want associated with this request.';
  rentButton.removeAttribute('aria-haspopup');
  rentButton.removeAttribute('aria-controls');
  rentButton.disabled = false;

  function showStatus(message) {
    notice.textContent = message;
    notice.hidden = false;
  }

  function showTracking(id) {
    showStatus(`Payment confirmed. Your tracking ID is ${id}.`);
    document.querySelector('#tracking-title').textContent = 'Your rental is confirmed';
    document.querySelector('#tracking-description').textContent = 'Save this ID for your records.';
    trackingId.textContent = id;
    if (typeof trackingDialog.showModal === 'function') trackingDialog.showModal();
  }

  function openSolana(quote, id) {
    if (quote.status === 'paid' && typeof quote.trackingId === 'string') {
      rentButton.disabled = true;
      showTracking(quote.trackingId);
      return;
    }
    if (quote.status !== 'pending' || !quote.uri?.startsWith('solana:') || !quote.qr?.startsWith('data:image/png;base64,')) {
      throw new Error('Invalid payment instructions.');
    }
    solanaRequestId = id;
    const location = new URL(window.location.href);
    location.search = new URLSearchParams({ checkout: 'solana', request_id: id });
    history.replaceState(null, '', location);
    document.querySelector('#solana-amount').textContent = quote.amount;
    document.querySelector('#solana-qr').src = quote.qr;
    document.querySelector('#solana-wallet-link').href = quote.uri;
    document.querySelector('#solana-signature').value = '';
    solanaStatus.textContent = '';
    showStatus('Your rental brief is saved. Resume the Solana payment to check its status.');
    resumeSolana.hidden = false;
    rentButton.disabled = true;
    solanaDialog.showModal();
    startSolanaPoll();
  }

  async function checkSolanaPayment(signature = '') {
    if (checkingSolana || !solanaRequestId) return;
    checkingSolana = true;
    solanaVerify.querySelector('button').disabled = true;
    solanaStatus.textContent = 'Checking the Solana network…';
    try {
      const response = await fetch(new URL('/api/rentals/solana/verify', checkoutApi), {
        method: 'POST',
        body: new URLSearchParams({ request_id: solanaRequestId, signature }),
        signal: AbortSignal.timeout(20_000)
      });
      const result = await response.json();
      if (!response.ok) {
        solanaStatus.textContent = result.error || 'The payment check is temporarily unavailable.';
      } else if (result.status === 'paid' && typeof result.trackingId === 'string') {
        clearInterval(solanaPoll);
        solanaDialog.close();
        resumeSolana.hidden = true;
        showTracking(result.trackingId);
      } else {
        solanaStatus.textContent = 'Waiting for a matching finalized payment. You can check again in a moment.';
      }
    } catch {
      solanaStatus.textContent = 'The Solana network could not be reached. Check again in a moment.';
    } finally {
      checkingSolana = false;
      solanaVerify.querySelector('button').disabled = false;
    }
  }

  function startSolanaPoll() {
    solanaChecks = 0;
    clearInterval(solanaPoll);
    solanaPoll = setInterval(() => {
      if (++solanaChecks > 12) {
        clearInterval(solanaPoll);
        return;
      }
      checkSolanaPayment();
    }, 8_000);
  }

  solanaDialog.querySelector('.close').addEventListener('click', () => solanaDialog.close());
  solanaDialog.addEventListener('close', () => clearInterval(solanaPoll));
  resumeSolana.addEventListener('click', () => {
    solanaDialog.showModal();
    startSolanaPoll();
  });
  solanaVerify.addEventListener('submit', event => {
    event.preventDefault();
    checkSolanaPayment(document.querySelector('#solana-signature').value.trim());
  });

  fetch(new URL('/api/rentals/options', checkoutApi), { signal: AbortSignal.timeout(5_000) })
    .then(response => response.ok ? response.json() : null)
    .then(options => {
      if (options?.solana === true && typeof solanaDialog.showModal === 'function') paymentMethods.hidden = false;
    }).catch(() => {});

  rentalForm.addEventListener('input', () => { requestId = undefined; });
  rentalForm.addEventListener('submit', async event => {
    event.preventDefault();
    if (rentButton.disabled) {
      return;
    }
    rentButton.disabled = true;
    requestId ??= crypto.randomUUID();
    const data = new FormData(rentalForm);
    data.set('request_id', requestId);
    const solanaPayment = data.get('payment_provider') === 'solana';
    showStatus(solanaPayment ? 'Saving your rental and getting a USDC quote…' : 'Saving your rental and opening Stripe Checkout…');

    try {
      const response = await fetch(new URL('/api/rentals', checkoutApi), {
        method: 'POST',
        body: data,
        signal: AbortSignal.timeout(35_000)
      });
      const result = await response.json();
      if (!response.ok) {
        showStatus(result.error || 'Checkout is temporarily unavailable. Please try again.');
      } else if (solanaPayment) {
        openSolana(result, data.get('request_id'));
        return;
      } else if (isStripeCheckout(result.url)) {
        try { sessionStorage.setItem(browserStorageKey, result.url); } catch {}
        window.location.assign(result.url);
        return;
      } else {
        showStatus('Stripe did not return a checkout link. Please try again.');
      }
    } catch {
      showStatus('Checkout could not be reached. Please try again to resume the same rental.');
    }

    rentButton.disabled = false;
    notice.scrollIntoView({ block: 'nearest' });
  });

  const returnParams = new URLSearchParams(window.location.search);
  if (returnParams.get('checkout') === 'cancel') {
    showStatus('You left Stripe Checkout. You can resume the same payment or complete a new brief.');
    let url;
    try { url = sessionStorage.getItem(browserStorageKey); } catch {}
    if (isStripeCheckout(url)) {
      resumeLink.href = url;
      resumeLink.hidden = false;
    }
    notice.scrollIntoView({ block: 'nearest' });
  } else if (returnParams.get('checkout') === 'solana') {
    rentButton.disabled = true;
    const id = returnParams.get('request_id');
    const quoteUrl = new URL('/api/rentals/solana', checkoutApi);
    quoteUrl.searchParams.set('request_id', id ?? '');
    fetch(quoteUrl, { signal: AbortSignal.timeout(10_000) })
      .then(response => {
        if (!response.ok) throw new Error('Missing Solana quote.');
        return response.json();
      })
      .then(quote => openSolana(quote, id))
      .catch(() => showStatus('Your Solana payment could not be loaded. Refresh to try again or contact us if you already paid.'));
  } else if (returnParams.get('checkout') === 'return') {
    rentButton.disabled = true;
    const sessionId = returnParams.get('session_id') ?? '';
    if (/^cs_(test|live)_[A-Za-z0-9]{8,120}$/.test(sessionId)) {
      checkPayment(sessionId);
    } else {
      showStatus('The checkout reference is missing. Contact us if you completed the payment.');
      rentButton.disabled = false;
    }
  }

  async function checkPayment(sessionId) {
    const statusUrl = new URL('/api/rentals/status', checkoutApi);
    statusUrl.searchParams.set('session_id', sessionId);
    showStatus('Checking your payment…');
    notice.scrollIntoView({ block: 'nearest' });

    for (let attempt = 0; attempt < 10; attempt += 1) {
      try {
        const response = await fetch(statusUrl, { signal: AbortSignal.timeout(5_000) });
        if (response.ok) {
          const result = await response.json();
          if (result.status === 'paid' && typeof result.trackingId === 'string') {
            try { sessionStorage.removeItem(browserStorageKey); } catch {}
            showTracking(result.trackingId);
            return;
          }
          if (result.status === 'failed' || result.status === 'expired') {
            showStatus('Stripe reports that this checkout closed without confirmation. Check your bank app before starting a new rental.');
            rentButton.disabled = false;
            return;
          }
        }
      } catch {}
      await new Promise(resolve => setTimeout(resolve, 1_500));
    }
    showStatus('Payment confirmation is still pending. Refresh this page to check again, or contact us if you already paid.');
  }
}

if (checkoutApi) {
  setupStripeCheckout();
} else {
  setupPreview();
}
