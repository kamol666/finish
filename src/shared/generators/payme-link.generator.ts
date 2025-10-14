import { config } from '../config';
import logger from '../utils/logger';
import { buildMaskedPaymentLink } from '../utils/payment-link.util';
import { createSignedToken } from '../utils/signed-token.util';

export type PaymeLinkGeneratorParams = {
  planId: string;
  userId: string;
  amount: number;
};

const PAYME_CHECKOUT_URL = 'https://checkout.paycom.uz';

export function buildPaymeProviderUrl(params: PaymeLinkGeneratorParams): string {
  const merchantId = config.PAYME_MERCHANT_ID;
  const amountInTiyns = params.amount * 100;
  const paramsInString = `m=${merchantId};ac.plan_id=${params.planId};ac.user_id=${params.userId};ac.selected_service=${params.planId};a=${amountInTiyns}`;
  logger.info(paramsInString);
  const encodedParams = base64Encode(paramsInString);
  return `${PAYME_CHECKOUT_URL}/${encodedParams}`;
}

export function generatePaymeLink(params: PaymeLinkGeneratorParams): string {
  const token = createSignedToken(params, config.PAYMENT_LINK_SECRET);
  const redirectUrl = buildMaskedPaymentLink(`payme?token=${token}`);
  if (!redirectUrl) {
    return buildPaymeProviderUrl(params);
  }

  return redirectUrl;
}

function base64Encode(input: string): string {
  return Buffer.from(input).toString('base64');
}
