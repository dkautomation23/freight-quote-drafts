// What a correct reading of each demo email looks like. Written by hand, before the model was run.
module.exports = {
  '01-full': { quote: true, lanes: [{ o: 'Dallas, TX', d: 'Atlanta, GA', eq: 'dry van', w: 40000, date: '2026-09-25', missing: [], rate: 1850 }] },
  '02-no-weight': { quote: true, lanes: [{ o: 'Houston, TX', d: 'Memphis, TN', eq: 'dry van', w: null, date: '2026-09-28', missing: ['weight_lbs'], rate: 1425 }] },
  '03-no-date': { quote: true, lanes: [{ o: 'Chicago, IL', d: 'Columbus, OH', eq: 'dry van', w: 42000, date: null, missing: ['pickup_date'], rate: 975 }] },
  '04-two-lanes': { quote: true, lanes: [
    { o: 'Atlanta, GA', d: 'Charlotte, NC', eq: 'dry van', w: 35000, date: '2026-09-29', missing: [], rate: 725 },
    { o: 'Atlanta, GA', d: 'Nashville, TN', eq: 'dry van', w: 35000, date: '2026-09-30', missing: [], rate: 'none' }
  ] },
  '05-reefer': { quote: true, lanes: [{ o: 'Fresno, CA', d: 'Denver, CO', eq: 'reefer', w: 38000, date: '2026-09-29', missing: [], rate: 'similar' }] },
  '06-flatbed': { quote: true, lanes: [{ o: 'Birmingham, AL', d: 'Houston, TX', eq: 'flatbed', w: 45000, date: '2026-10-01', missing: [], rate: 'none' }] },
  '07-not-a-quote': { quote: false },
  '08-reply-in-thread': { quote: true, lanes: [{ o: 'Omaha, NE', d: 'Kansas City, MO', eq: 'reefer', w: 30000, date: '2026-10-01', missing: [], rate: 675 }] },
  '09-signature-phone': { quote: true, lanes: [{ o: 'Phoenix, AZ', d: 'Las Vegas, NV', eq: 'dry van', w: 20000, date: '2026-09-30', missing: [], rate: 825 }] },
  '10-typos': { quote: true, lanes: [{ o: 'Los Angeles, CA', d: 'San Antonio, TX', eq: 'dry van', w: 44000, date: '2026-10-02', missing: [], rate: 2950 }] },
  // Added 27.09 after the live run: the real test email had the request in the subject and "Hi" as the body.
  '11-subject-only': { quote: true, lanes: [{ o: 'Memphis, TN', d: 'Dallas, TX', eq: 'reefer', w: 30000, date: '2026-09-28', missing: [], rate: 'none' }] }
};
