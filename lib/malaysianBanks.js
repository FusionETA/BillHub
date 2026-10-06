// Malaysian bank codes, as Hong Leong's ConnectFirst bulk template publishes
// them. Three schemes, three code lists, and they disagree: Alliance
// Investment is AMB under RENTAS and MBAM in the IBG list, so a single table
// would be wrong somewhere.
//
// Keys are bank names squashed to letters and digits with "Berhad", "Bhd",
// "Malaysia" and anything parenthesised removed, so whatever a Xero contact
// says — "Maybank", "MAYBANK BERHAD", "Malayan Banking Berhad" — lands on the
// same entry. Extracted from CFIRST_Bulk.xls rather than typed.
const CODES = {
  AEONBANK: {"duitnow": "ACDB", "rentas": "ACDB"},
  AFFIN: {"duitnow": "PABB", "ibg": "PABB", "rentas": "PABB"},
  AFFINBANK: {"duitnow": "PABB", "ibg": "PABB", "rentas": "PABB"},
  AFFINHWANGINVESTMENTBANK: {"rentas": "HDBS"},
  AFFINISLAMICBANK: {"rentas": "IPHB"},
  AGROBANK: {"duitnow": "AGRO", "ibg": "AGRO", "rentas": "AGRO"},
  AGROBANKSPI: {"rentas": "IAGR"},
  ALLIANCE: {"duitnow": "ALBB", "ibg": "ALBB", "rentas": "ALBB"},
  ALLIANCEBANK: {"duitnow": "ALBB", "ibg": "ALBB", "rentas": "ALBB"},
  ALLIANCEINVESTMENTBANK: {"rentas": "AMB"},
  ALLIANCEINVESTMENTBANKSPI: {"rentas": "IAMB"},
  ALLIANCEISLAMICBANK: {"rentas": "AIBB"},
  ALRAJHIBANK: {"ibg": "ARB"},
  ALRAJHIBANKINGINVCORPB: {"rentas": "ARB"},
  ALRAJHIBANKINGINVESTMENTCORPORATION: {"duitnow": "ARB"},
  AMBANK: {"duitnow": "AMBB", "ibg": "AMBB", "rentas": "AMBB"},
  AMINVESTMENTBANK: {"rentas": "AMM"},
  AMINVESTMENTBANKSPI: {"rentas": "IAMM"},
  AMISLAMICBANK: {"rentas": "IARB"},
  BANGKOKBANK: {"ibg": "BKKB", "rentas": "BKKB"},
  BANKISLAM: {"duitnow": "BIMB", "ibg": "BIMB", "rentas": "BIMB"},
  BANKKERJASAMARAKYAT: {"duitnow": "BKRM", "ibg": "BKRM", "rentas": "BKRM"},
  BANKMUAMALAT: {"duitnow": "BMMB", "ibg": "BMMB", "rentas": "BMMB"},
  BANKNEGARA: {"rentas": "BNM"},
  BANKOFAMERICA: {"duitnow": "BOFA", "ibg": "BOFA", "rentas": "BOFA"},
  BANKOFCHINA: {"duitnow": "BOCM", "ibg": "BOCM", "rentas": "BOCM"},
  BANKPEMBANGUNAN: {"rentas": "PEMB"},
  BANKPEMBANGUNANSPI: {"rentas": "IPEM"},
  BANKRAKYAT: {"duitnow": "BKRM", "ibg": "BKRM", "rentas": "BKRM"},
  BANKSIMPANANNASIONAL: {"duitnow": "BSNB", "ibg": "BSNB", "rentas": "BSNB"},
  BANKSIMPANANNASIONALSPI: {"rentas": "BSNI"},
  BIGPAY: {"duitnow": "BGPY"},
  BNPPARIBAS: {"duitnow": "BNPM", "ibg": "BNPM", "rentas": "BNPM"},
  BNPPARIBASSPI: {"rentas": "BNPI"},
  BOOSTBANK: {"duitnow": "BOST"},
  BOOSTEWALLET: {"duitnow": "BOBE"},
  BSN: {"duitnow": "BSNB", "ibg": "BSNB", "rentas": "BSNB"},
  BURSADEPOSITORY: {"rentas": "MCDS"},
  CAGAMAS: {"rentas": "CAGA"},
  CAGAMASSPI: {"rentas": "ICAG"},
  CHINACONSTRUCTIONBANK: {"duitnow": "CCBM", "ibg": "CCBM", "rentas": "CCBM"},
  CIMB: {"duitnow": "CIMB", "ibg": "CIMB", "rentas": "CIMB"},
  CIMBBANK: {"duitnow": "CIMB", "ibg": "CIMB", "rentas": "CIMB"},
  CIMBINVESTMENTBANK: {"rentas": "COIM"},
  CIMBINVESTMENTBANKSPI: {"rentas": "ICIM"},
  CIMBISLAMICBANK: {"rentas": "CTBB"},
  CITIBANK: {"duitnow": "CITI", "ibg": "CITI", "rentas": "CITI"},
  CITIBANKSPI: {"rentas": "ICIT"},
  DEUTSCHEBANK: {"duitnow": "DEUM", "ibg": "DEUM", "rentas": "DEUM"},
  DEUTSCHEBANKSPI: {"rentas": "DEUT"},
  DUITNOWTOBUSINESSREGISTRATION: {"duitnow": "BRNO"},
  DUITNOWTOICNUMBER: {"duitnow": "ICNO"},
  DUITNOWTOMOBILENUMBER: {"duitnow": "MBNO"},
  DUITNOWTOPASSPORT: {"duitnow": "PPNO"},
  EXPORTIMPORTBANK: {"rentas": "EXM"},
  EXPORTIMPORTBANKSPI: {"rentas": "IEXM"},
  FINEXUS: {"duitnow": "FNXS"},
  GRABPAY: {"duitnow": "GRAB"},
  GXBANK: {"duitnow": "GXSP"},
  HONGLEONG: {"duitnow": "HLBB", "ibg": "HLBB", "rentas": "HLBB"},
  HONGLEONGBANK: {"duitnow": "HLBB", "ibg": "HLBB", "rentas": "HLBB"},
  HONGLEONGINVESTMENTBANK: {"rentas": "PMB"},
  HSBC: {"duitnow": "HSBC", "ibg": "HSBC", "rentas": "HSBC"},
  HSBCAMANAH: {"rentas": "IHMA"},
  HSBCBANK: {"duitnow": "HSBC", "ibg": "HSBC", "rentas": "HSBC"},
  INDCOMMBANKOFCHINA: {"ibg": "ICBC", "rentas": "ICBC"},
  INDIANINTERNATIONALBANK: {"rentas": "IIMB"},
  INDUSTRIALANDCOMMERCIALBANKOFCHINA: {"duitnow": "ICBC"},
  JPMORGANCHASEBANK: {"duitnow": "JPMC", "ibg": "JPMC", "rentas": "JPMC"},
  KAFDIGITALBANK: {"duitnow": "KAF"},
  KAFINVESTMENTBANK: {"rentas": "KAF"},
  KAFINVESTMENTBANKSPI: {"rentas": "IKAF"},
  KENANGAINVESTMENTBANK: {"rentas": "KKE"},
  KENANGAINVESTMENTBANKSPI: {"rentas": "KKEI"},
  KIMPULANWANGSIMPANANPEKERJACONV: {"rentas": "KWSP"},
  KUMPULANWANGPERSARAAN: {"rentas": "KWAP"},
  KUWAITFINANCEHOUSE: {"duitnow": "KFHB", "ibg": "KFHB", "rentas": "KFHB"},
  MALAYANBANKING: {"duitnow": "MBBB", "ibg": "MBBB", "rentas": "MBBB"},
  MAYBANK: {"duitnow": "MBBB", "ibg": "MBBB", "rentas": "MBBB"},
  MAYBANKINVESTMENTBANK: {"rentas": "ASB"},
  MAYBANKINVESTMENTBANKSPI: {"rentas": "IASB"},
  MAYBANKISLAMIC: {"rentas": "IMBB"},
  MBSBBANK: {"duitnow": "AFB", "ibg": "AFB", "rentas": "AFB"},
  MERCHANTRADE: {"duitnow": "MASB"},
  MIDFAMANAHINVESTMENTBANK: {"rentas": "UMB"},
  MIDFAMANAHINVESTMENTBANKSPI: {"rentas": "IMAI"},
  MIZUHOBANK: {"duitnow": "MHCB", "ibg": "MHCB", "rentas": "MHCB"},
  MUFGBANK: {"duitnow": "BTMU", "ibg": "BTMU", "rentas": "BTMU"},
  MUFGBANKSPI: {"rentas": "IBOT"},
  OCBC: {"duitnow": "OCBC", "ibg": "OCBC", "rentas": "OCBC"},
  OCBCALAMINBANK: {"rentas": "IOAB"},
  OCBCBANK: {"duitnow": "OCBC", "ibg": "OCBC", "rentas": "OCBC"},
  PUBLICBANK: {"duitnow": "PBBB", "ibg": "PBBB", "rentas": "PBBB"},
  PUBLICINVESTMENTBANK: {"rentas": "PMBB"},
  PUBLICISLAMICBANK: {"rentas": "PIBB"},
  RHB: {"duitnow": "RHBB", "ibg": "RHBB", "rentas": "RHBB"},
  RHBBANK: {"duitnow": "RHBB", "ibg": "RHBB", "rentas": "RHBB"},
  RHBINVESTMENTBANK: {"rentas": "OSK"},
  RHBISLAMICBANK: {"rentas": "IRHB"},
  RYTBANK: {"duitnow": "RYTB"},
  SHOPEE: {"duitnow": "ARPY"},
  SMEBANK: {"rentas": "SME"},
  SMEBANKSPI: {"rentas": "ISME"},
  STANDARDCHARTERED: {"duitnow": "SCBB", "ibg": "SCBB", "rentas": "SCBB"},
  STANDARDCHARTEREDBANK: {"duitnow": "SCBB", "ibg": "SCBB", "rentas": "SCBB"},
  STANDARDCHARTEREDSAADIQ: {"rentas": "SCSB"},
  SUMITOMOMITSUIBANK: {"ibg": "SMBC", "rentas": "SMBC"},
  SUMITOMOMITSUIBANKINGCORPORATION: {"duitnow": "SMBC"},
  TOUCHNGOEWALLET: {"duitnow": "TNGD"},
  UNITEDOVERSEASBANK: {"duitnow": "UOBB"},
  UNITEDOVERSEASBANKM: {"ibg": "UOBB", "rentas": "UOBB"},
  UNITEDOVERSEASBANKMSPI: {"rentas": "IUOB"},
  UOB: {"duitnow": "UOBB", "ibg": "UOBB", "rentas": "UOBB"}
};

// The DuitNow proxy types, for paying something that is not a bank account.
const PROXY_TYPES = { BRNO: 'business registration', ICNO: 'IC number', MBNO: 'mobile number', PPNO: 'passport' };

function normalise(name) {
  return String(name || '')
    .toUpperCase()
    .replace(/\(.*?\)/g, ' ')
    .replace(/BERHAD/g, ' ')
    .replace(/ BHD/g, ' ')
    .replace(/MALAYSIA/g, ' ')
    .replace(/[^A-Z0-9]+/g, '');
}

// BNM's two-digit IBG codes, which CIMB's BizConverter publishes and Hong
// Leong's workbook does not. A fifth column in the table above would have
// been tidier and wrong: these come from a different bank's documentation,
// and when the two disagree it should be obvious which file each came from.
//
// Extracted from the BizConverter's "BNM Code" sheet, not typed. Names with a
// slash — "Public Bank Berhad/ Public Finance Berhad" — are indexed on both
// halves, since either is what someone might have written in Xero.
const BNM = {
  AFFINBANK: '32-Affin Bank Berhad',
  AGROBANK: '49-Agro Bank',
  ALLIANCEBANK: '12-Alliance Bank Berhad',
  ALRAJHIBANKINGANDINVESTMENTCORPORATION: '53-Al-Rajhi Banking and Investment Corporation (Malaysia) Berhad',
  AMBANK: '08-AmBank Berhad',
  BANGKOKBANK: '04-Bangkok Bank Berhad',
  BANKISLAM: '45-Bank Islam Malaysia Berhad',
  BANKMUAMALAT: '41-Bank Muamalat Malaysia Berhad',
  BANKOFAMERICA: '07-Bank of America',
  BANKOFCHINA: '42-Bank of China (Malaysia) Berhad',
  BANKOFTOKYOMITSUBISHIUFJ: '52-Bank of Tokyo-Mitsubishi UFJ (Malaysia) Berhad',
  BANKRAKYAT: '02-Bank Rakyat Berhad',
  BANKSIMPANANNASIONAL: '10-Bank Simpanan Nasional Berhad',
  BNPPARIBAS: '60-BNP Paribas (M) Bhd / BNP Paribas (Islamic)',
  CHINACONSTRUCTIONBANK: '65-China Construction Bank (Malaysia) Berhad',
  CIMBBANK: '35-CIMB Bank Berhad',
  CITIBANK: '17-Citibank',
  DEUTSCHEBANK: '19-Deutsche Bank (M) Bhd',
  HONGLEONGBANK: '24-Hong Leong Bank Berhad/ Hong Leong Finance',
  HONGLEONGFINANCE: '24-Hong Leong Bank Berhad/ Hong Leong Finance',
  HSBCBANK: '22-HSBC Bank Berhad',
  INDUSTCOMMBANKOFCHINA: '59-Indust & Comm Bank of China (M) Berhad',
  JPMORGANCHASE: '48-JP Morgan Chase',
  KUWAITFINANCEHOUSE: '47-Kuwait Finance House',
  MALAYANBANKING: '27-Malayan Banking Berhad',
  MBSB: '75-MBSB',
  MIZUHOBANK: '73-Mizuho Bank (M) Berhad',
  OCBCBANK: '29-OCBC Bank Berhad',
  PUBLICBANK: '33-Public Bank Berhad/ Public Finance Berhad',
  PUBLICFINANCE: '33-Public Bank Berhad/ Public Finance Berhad',
  RHBBANK: '18-RHB Bank Berhad',
  STANDARDCHARTEREDBANK: '14-Standard Chartered Bank Berhad',
  SUMITOMOMITSUIBANKINGCORPORATION: '51-Sumitomo Mitsui Banking Corporation (M) Bhd',
  THEROYALBANKOFSCOTLAND: '46-The Royal Bank of Scotland Bhd',
  UNITEDOVERSEASBANK: '26-United Overseas Bank (M) Bhd',
};

// The same bank written the way the other file writes it. BizConverter says
// "Malayan Banking Berhad" where everyone, including Xero, says "Maybank".
//
// Only trading names of the SAME legal entity are here. Alliance Investment
// Bank is not Alliance Bank, Hong Leong Investment Bank is not Hong Leong
// Bank, and an Islamic subsidiary is not its parent — Hong Leong's own sheets
// give each of those a different code, which is the clearest evidence that
// collapsing them would be wrong. They resolve to nothing and the line warns,
// which is the right outcome: CIMB's list has 33 IBG participants and most of
// those entities are not among them.
const BNM_ALIASES = {
  MAYBANK: 'MALAYANBANKING',
  AFFIN: 'AFFINBANK',
  ALLIANCE: 'ALLIANCEBANK',
  CIMB: 'CIMBBANK',
  HONGLEONG: 'HONGLEONGBANK',
  HSBC: 'HSBCBANK',
  OCBC: 'OCBCBANK',
  RHB: 'RHBBANK',
  STANDARDCHARTERED: 'STANDARDCHARTEREDBANK',
  UNITEDOVERSEASBANKM: 'UNITEDOVERSEASBANK',
  SUMITOMOMITSUIBANK: 'SUMITOMOMITSUIBANKINGCORPORATION',
  MUFGBANK: 'BANKOFTOKYOMITSUBISHIUFJ',
  ICBC: 'INDUSTCOMMBANKOFCHINA',
  JPMORGAN: 'JPMORGANCHASE',
  ALRAJHIBANK: 'ALRAJHIBANKINGANDINVESTMENTCORPORATION',
  MBSBBANK: 'MBSB',
  BANKKERJASAMARAKYAT: 'BANKRAKYAT'
};

// The whole dropdown entry — "35-CIMB Bank Berhad" — because that is what
// BizConverter's sheet holds. The column's own rule says "Length: 2 (Num
// Only)", which describes what its macro writes into the .txt, not what goes
// in the cell; their filled sheets carry the label. Following the rule rather
// than the data produced a file with a bare "35" in it.
function bnmLabel(name) {
  const key = normalise(name);
  return BNM[key] || BNM[BNM_ALIASES[key]] || null;
}

function bnmCode(name) {
  const label = bnmLabel(name);
  return label ? label.slice(0, 2) : null;
}

// The 4-character code for a bank name under one scheme, or null when the name
// is not one we can place. Null matters: it is the difference between a line
// the bank will reject and one Bills Hub can refuse to write.
function bankCode(name, scheme = 'duitnow') {
  if (PROXY_TYPES[String(name || '').toUpperCase()]) return String(name).toUpperCase();
  // CIMB's scheme is its own table and has no fallback: a Hong Leong code in
  // a BNM column is not a near miss, it is a different bank.
  if (scheme === 'bnm') return bnmCode(name);
  const row = CODES[normalise(name)];
  if (!row) return null;
  return row[scheme] || row.duitnow || row.ibg || row.rentas || null;
}

// A JomPay biller code is all digits; a bank is not. That is the whole rule
// Ayu Borneo use to tell a utility from a supplier, and it needs no new field.
function isBillerCode(bankAccountName) {
  // JomPay biller codes are four or five digits — Ayu Borneo's are 5454, 4200
  // and 2881. The earlier rule allowed up to eight, which an ordinary bank
  // account number can be, and that is the one mistake here that would route
  // a supplier payment down the wrong rail.
  return /^\d{4,5}$/.test(String(bankAccountName || '').trim());
}

function knownBanks() {
  return Object.keys(CODES).length;
}

module.exports = { bankCode, bnmCode, bnmLabel, isBillerCode, normalise, knownBanks, PROXY_TYPES, CODES, BNM };
