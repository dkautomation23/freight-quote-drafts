// Invented demo data. All companies, people, addresses and numbers are made up;
// emails use the reserved example.com / example.net / example.org domains and 555-01xx phone numbers.
// Used by "Quote Assistant > Load demo emails" and by the Node tests.

var DEMO_BROKER = 'Sam Reyes';
var DEMO_COMPANY = 'Northline Freight (demo)';

var DEMO_EMAILS = [
  {
    id: '01-full',
    subject: 'Rate request Dallas to Atlanta',
    messages: [{
      from: 'Laura Kim <laura.kim@example.com>', date: '2026-09-24T14:05:00Z',
      body: 'Hi,\n\nRate for Dallas TX -> Atlanta GA, dry van, 40,000 lbs, pickup Fri.\n\nThanks,\nLaura'
    }]
  },
  {
    id: '02-no-weight',
    subject: 'Quote Houston - Memphis',
    messages: [{
      from: 'Carlos Mendes <cmendes@example.net>', date: '2026-09-24T14:12:00Z',
      body: 'Good afternoon,\n\nCan you quote a dry van from Houston, TX to Memphis, TN? Pickup Monday 9/28, delivery Tuesday.\n\nCarlos'
    }]
  },
  {
    id: '03-no-date',
    subject: 'Need a price',
    messages: [{
      from: 'Priya Shah <priya@example.org>', date: '2026-09-24T14:20:00Z',
      body: 'Hello,\n\nWhat would you charge for 42,000 lbs of boxed paper goods, Chicago IL to Columbus OH, 53\' dry van?\n\nPriya Shah\nShipping Coordinator'
    }]
  },
  {
    id: '04-two-lanes',
    subject: 'Two loads out of Atlanta next week',
    messages: [{
      from: 'Dana Brooks <dana.brooks@example.com>', date: '2026-09-24T14:31:00Z',
      body: 'Hi team,\n\nI need rates on two loads, both dry van, 35,000 lbs each:\n1) Atlanta, GA to Charlotte, NC - pickup Tuesday\n2) Atlanta, GA to Nashville, TN - pickup Wednesday\n\nThank you,\nDana'
    }]
  },
  {
    id: '05-reefer',
    subject: 'Reefer quote Fresno to Denver',
    messages: [{
      from: 'Tom Alvarez <tom.alvarez@example.net>', date: '2026-09-24T14:40:00Z',
      body: 'Hi,\n\nLooking for a reefer rate. Fresh produce, 38,000 lbs, Fresno CA to Denver CO, must stay at 34F. Pickup 9/29 morning.\n\nTom'
    }]
  },
  {
    id: '06-flatbed',
    subject: 'Flatbed - steel coils',
    messages: [{
      from: 'Rachel Nguyen <rnguyen@example.org>', date: '2026-09-24T14:52:00Z',
      body: 'Hello,\n\nPlease send a rate for a flatbed load of steel coils, 45,000 lbs, Birmingham AL to Houston TX. Tarps required. Ready to ship 10/1.\n\nRegards,\nRachel Nguyen'
    }]
  },
  {
    id: '07-not-a-quote',
    subject: 'Invoice 4471 - payment status',
    messages: [{
      from: 'Accounts Payable <ap@example.com>', date: '2026-09-24T15:03:00Z',
      body: 'Hello,\n\nWe received your invoice 4471 for the load from Dallas to Atlanta on 9/10. Payment is scheduled for 10/5 by ACH. Please let us know if your bank details have changed.\n\nAccounts Payable'
    }]
  },
  {
    id: '08-reply-in-thread',
    subject: 'Re: Reefer Omaha to Kansas City',
    messages: [
      {
        from: 'Ben Carter <ben.carter@example.net>', date: '2026-09-24T13:10:00Z',
        body: 'Hi,\n\nNeed a price on a reefer load Omaha NE to Kansas City MO, next Thursday. Frozen food, keep at 0F.\n\nBen'
      },
      {
        from: 'Sam Reyes <me@example.com>', date: '2026-09-24T13:40:00Z', isMine: true,
        body: 'Hi Ben,\n\nThanks. What is the total weight?\n\nSam'
      },
      {
        from: 'Ben Carter <ben.carter@example.net>', date: '2026-09-24T15:15:00Z',
        body: 'About 30,000 lbs.\n\nBen\n\nOn Thu, Sep 24, 2026 at 1:40 PM Sam Reyes <me@example.com> wrote:\n> Hi Ben,\n> Thanks. What is the total weight?\n> Sam'
      }
    ]
  },
  {
    id: '09-signature-phone',
    subject: 'Phoenix to Vegas',
    messages: [{
      from: 'Mike Turner <mturner@example.com>', date: '2026-09-24T15:27:00Z',
      body: 'Hi,\n\nCould you give me a rate Phoenix AZ to Las Vegas NV, dry van, 20,000 lbs, pickup 9/30?\n\nThanks\n\nMike Turner | Logistics Manager\nDesert Supply Co.\n2200 Industrial Way, Tucson, AZ 85701\nPhone: (555) 010-4477 | Cell: (555) 010-9921'
    }]
  },
  {
    id: '10-typos',
    subject: 'rate pls',
    messages: [{
      from: 'jstone@example.org', date: '2026-09-24T15:38:00Z',
      body: 'lookin for a rate from Los Angelas CA to San Antonoi TX, 53 ft van, 44k, pick up 10/2'
    }]
  }
];

// Rate history: what the broker charged before. Columns match the "Rate history" sheet.
var DEMO_RATES = [
  ['2026-09-10', 'Dallas', 'TX', 'Atlanta', 'GA', 'dry van', 1850],
  ['2026-09-03', 'Dallas', 'TX', 'Atlanta', 'GA', 'dry van', 1900],
  ['2026-08-27', 'Dallas', 'TX', 'Atlanta', 'GA', 'dry van', 1800],
  ['2026-09-15', 'Houston', 'TX', 'Memphis', 'TN', 'dry van', 1400],
  ['2026-09-01', 'Houston', 'TX', 'Memphis', 'TN', 'dry van', 1450],
  ['2026-09-18', 'Chicago', 'IL', 'Columbus', 'OH', 'dry van', 950],
  ['2026-09-08', 'Chicago', 'IL', 'Columbus', 'OH', 'dry van', 1000],
  ['2026-08-30', 'Chicago', 'IL', 'Columbus', 'OH', 'dry van', 975],
  ['2026-09-16', 'Atlanta', 'GA', 'Charlotte', 'NC', 'dry van', 700],
  ['2026-09-02', 'Atlanta', 'GA', 'Charlotte', 'NC', 'dry van', 750],
  ['2026-09-12', 'Bakersfield', 'CA', 'Denver', 'CO', 'reefer', 2600],
  ['2026-08-29', 'Bakersfield', 'CA', 'Denver', 'CO', 'reefer', 2750],
  ['2026-09-17', 'Omaha', 'NE', 'Kansas City', 'MO', 'reefer', 650],
  ['2026-09-04', 'Omaha', 'NE', 'Kansas City', 'MO', 'reefer', 700],
  ['2026-09-14', 'Phoenix', 'AZ', 'Las Vegas', 'NV', 'dry van', 800],
  ['2026-09-07', 'Phoenix', 'AZ', 'Las Vegas', 'NV', 'dry van', 850],
  ['2026-08-31', 'Phoenix', 'AZ', 'Las Vegas', 'NV', 'dry van', 825],
  ['2026-09-11', 'Los Angeles', 'CA', 'San Antonio', 'TX', 'dry van', 2900],
  ['2026-09-05', 'Los Angeles', 'CA', 'San Antonio', 'TX', 'dry van', 3000],
  ['2026-09-09', 'Birmingham', 'AL', 'Houston', 'TX', 'dry van', 1500]
];

var RATE_HEADERS = ['Date', 'Origin city', 'Origin state', 'Destination city', 'Destination state', 'Equipment', 'Rate (USD)'];

function rateRowsFromTable(values) {
  return values.filter(function (r) { return r[1] && r[3]; }).map(function (r) {
    return { date: r[0], originCity: r[1], originState: r[2], destCity: r[3], destState: r[4], equipment: r[5], rate: r[6] };
  });
}
