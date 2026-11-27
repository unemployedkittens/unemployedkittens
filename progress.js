const progressApi = new URL('/api/rentals/progress',
  document.querySelector('meta[name="rental-checkout-api"]').content);
const lookup = document.querySelector('#job-lookup');
const lookupButton = lookup.querySelector('button');
const lookupMessage = document.querySelector('#lookup-message');
const jobsMessage = document.querySelector('#jobs-message');
const jobList = document.querySelector('#job-list');
const moreJobs = document.querySelector('#more-jobs');
const cardTemplate = document.querySelector('#job-template');
const dialog = document.querySelector('#job-dialog');
const animation = document.querySelector('#job-animation');
const toggleAnimation = document.querySelector('#toggle-animation');
let nextPage = 1;

async function fetchJson(url, options = {}) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(12_000) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Job progress is temporarily unavailable.');
  return result;
}

function describeStage(job) {
  return job.negotiated ? `Negotiation · ${job.negotiated} of 30 businesses` : job.name;
}

function openJob(job) {
  document.querySelector('#job-reference').textContent = `Job ${job.job}`;
  document.querySelector('#job-percent').textContent = `${job.percent}%`;
  document.querySelector('#job-meter').value = job.percent;
  document.querySelector('#job-milestone').textContent = describeStage(job);
  document.querySelectorAll('#job-stages li').forEach((item, index) => {
    const stage = index + 1;
    item.classList.toggle('is-complete', stage < job.stage || job.percent === 100);
    if (stage === job.stage) {
      item.setAttribute('aria-current', 'step');
    } else {
      item.removeAttribute('aria-current');
    }
  });
  dialog.showModal();
}

function addJob(job) {
  const card = cardTemplate.content.cloneNode(true);
  card.querySelector('.job-label').textContent = `Job ${job.job}`;
  card.querySelector('.job-percentage').textContent = `${job.percent}%`;
  card.querySelector('.job-card-stage').textContent = describeStage(job);
  card.querySelector('progress').value = job.percent;
  card.querySelector('button').addEventListener('click', () => openJob(job));
  jobList.append(card);
}

async function loadJobs() {
  moreJobs.disabled = true;
  try {
    const url = new URL(progressApi);
    url.searchParams.set('page', nextPage);
    const result = await fetchJson(url);
    result.jobs.forEach(addJob);
    nextPage = result.nextPage;
    moreJobs.hidden = !nextPage;
    jobsMessage.textContent = jobList.children.length ? '' : 'No paid jobs yet.';
  } catch {
    jobsMessage.textContent = 'Jobs are temporarily unavailable. Try again in a moment.';
    moreJobs.textContent = 'Try again';
    moreJobs.hidden = false;
  } finally {
    moreJobs.disabled = false;
  }
}

lookupButton.disabled = typeof dialog.showModal !== 'function';
lookup.addEventListener('submit', async event => {
  event.preventDefault();
  lookupButton.disabled = true;
  lookupMessage.textContent = 'Looking up your job…';
  try {
    const url = new URL(progressApi.href + '/lookup');
    const body = new URLSearchParams(new FormData(lookup));
    body.set('tracking_id', body.get('tracking_id').trim());
    const job = await fetchJson(url, { method: 'POST', body });
    lookupMessage.textContent = `Found Job ${job.job}.`;
    openJob(job);
  } catch (error) {
    lookupMessage.textContent = error.message || 'Job progress is temporarily unavailable.';
  } finally {
    lookupButton.disabled = false;
  }
});

moreJobs.addEventListener('click', () => {
  moreJobs.textContent = 'Show more jobs';
  loadJobs();
});
dialog.querySelector('.close').addEventListener('click', () => dialog.close());
toggleAnimation.addEventListener('click', () => {
  const paused = animation.classList.toggle('paused');
  toggleAnimation.textContent = paused ? 'Play animation' : 'Pause animation';
  toggleAnimation.setAttribute('aria-pressed', String(paused));
});
loadJobs();
