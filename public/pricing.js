let activeAuthData;
let selectedPlanKey;

const signinModal = document.getElementById('signin-modal');
const paymentModal = document.getElementById('payment-modal');
const pricingError = document.getElementById('pricing-error-msg');
const paymentError = document.getElementById('payment-error-msg');

function showPricingError(message) {
  pricingError.textContent = message;
  pricingError.hidden = false;
}

function closeModals() {
  signinModal.style.display = 'none';
  paymentModal.style.display = 'none';
}

async function loadConfig() {
  const response = await fetch('/api/config', { credentials: 'same-origin' });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Could not load your account. Please retry.');
  if (!data.auth || typeof data.auth.signedIn !== 'boolean') {
    throw new Error('The account response was invalid. Please retry.');
  }
  activeAuthData = data;
  return data;
}

async function showSubscribeModal(button) {
  selectedPlanKey = button.dataset.plan;
  const planName = button.dataset.name;
  const planPrice = button.dataset.price;
  if (!selectedPlanKey || !planName || !planPrice) {
    showPricingError('This plan is not configured correctly. Please refresh the page.');
    return;
  }

  let account = activeAuthData;
  try {
    account ||= await loadConfig();
  } catch (error) {
    showPricingError(error instanceof Error ? error.message : 'Could not load your account. Please retry.');
    return;
  }

  pricingError.hidden = true;
  if (!account.auth.signedIn) {
    document.getElementById('signin-plan-name').textContent = planName;
    signinModal.style.display = 'grid';
    return;
  }

  document.getElementById('payment-plan-name').textContent = planName;
  document.getElementById('payment-plan-price').textContent = `${planPrice} / month`;
  document.getElementById('expiry-minutes-input').value = '1';
  paymentError.style.display = 'none';
  const confirmButton = document.getElementById('modal-confirm-pay-btn');
  confirmButton.disabled = false;
  confirmButton.textContent = 'Yes, Complete Payment';
  paymentModal.style.display = 'grid';
}

async function confirmTestPayment(button) {
  if (!selectedPlanKey) {
    showPricingError('Please choose a plan before continuing.');
    return;
  }

  const input = document.getElementById('expiry-minutes-input').value.trim();
  const durationMinutes = input ? Number(input) : null;
  if (input && (!Number.isFinite(durationMinutes) || durationMinutes < 1)) {
    paymentError.textContent = 'Enter at least 1 minute, or clear the field for one month.';
    paymentError.style.display = 'block';
    return;
  }

  paymentError.style.display = 'none';
  button.disabled = true;
  button.textContent = 'Processing payment...';
  try {
    const response = await fetch('/api/plans/subscribe-test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ plan: selectedPlanKey, confirm: true, durationMinutes })
    });
    const result = await response.json();
    if (!response.ok || !result.ok) throw new Error(result.error || 'Subscription update failed. Please try again.');
    button.textContent = '✓ Test upgrade complete';
    window.setTimeout(() => window.location.reload(), 600);
  } catch (error) {
    paymentError.textContent = error instanceof Error ? error.message : 'Subscription update failed. Please try again.';
    paymentError.style.display = 'block';
    button.disabled = false;
    button.textContent = 'Yes, Complete Payment';
  }
}

document.querySelectorAll('.test-subscribe-btn').forEach((button) => {
  button.addEventListener('click', () => void showSubscribeModal(button));
});

document.getElementById('modal-confirm-pay-btn')
  .addEventListener('click', (event) => void confirmTestPayment(event.currentTarget));

document.querySelectorAll('.modal-close, .modal-dismiss').forEach((button) => {
  button.addEventListener('click', closeModals);
});

document.querySelectorAll('.auth-modal-backdrop').forEach((backdrop) => {
  backdrop.addEventListener('click', (event) => {
    if (event.target === backdrop) closeModals();
  });
});

window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') closeModals();
});

void loadConfig().then((data) => {
  if (!data.auth.signedIn) return;
  const currentPlan = (data.user?.plan || 'free').toLowerCase();
  document.querySelectorAll('.pricing-card').forEach((card) => {
    const planKey = card.dataset.plan;
    const button = card.querySelector('.test-subscribe-btn, .plan-action');
    if (!button || planKey !== currentPlan) return;

    let expiryLabel = '';
    if (data.user?.expireDate) {
      const expiry = new Date(data.user.expireDate);
      expiryLabel = ` · Expires ${expiry.toLocaleString([], {
        dateStyle: expiry.toDateString() === new Date().toDateString() ? undefined : 'short',
        timeStyle: 'short'
      })}`;
    }
    button.textContent = `${planKey === 'free' ? '✓ Current Free Plan' : '✓ Active Plan'}${expiryLabel}`;
    button.classList.add('active-plan-badge');
    button.title = 'Current active plan. Click to extend or test expiry duration.';
  })
}).catch((error) => {
  showPricingError(error instanceof Error ? error.message : 'Could not load account information.');
});
