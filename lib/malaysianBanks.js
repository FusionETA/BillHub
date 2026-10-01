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

// The 4-character code for a bank name under one scheme, or null when the name
// is not one we can place. Null matters: it is the difference between a line
// the bank will reject and one Bills Hub can refuse to write.
function bankCode(name, scheme = 'duitnow') {
  if (PROXY_TYPES[String(name || '').toUpperCase()]) return String(name).toUpperCase();
  const row = CODES[normalise(name)];
  if (!row) return null;
  return row[scheme] || row.duitnow || row.ibg || row.rentas || null;
}

// A JomPay biller code is all digits; a bank is not. That is the whole rule
// Ayu Borneo use to tell a utility from a supplier, and it needs no new field.
function isBillerCode(bankAccountName) {
  return /^\d{4,8}$/.test(String(bankAccountName || '').trim());
}

function knownBanks() {
  return Object.keys(CODES).length;
}

module.exports = { bankCode, isBillerCode, normalise, knownBanks, PROXY_TYPES, CODES };
