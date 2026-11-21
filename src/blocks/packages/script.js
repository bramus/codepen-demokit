import Specificity from '@bramus/specificity';

const [s] = Specificity.calculate('header:where(#top) nav li:nth-child(2n)');
document.body.innerText = s.toString();