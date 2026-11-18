import crypto from 'node:crypto';
import { BillingCheckoutSession, PlanTier } from '../shared/types';

export interface BillingWebhookPayload {
  workspaceId: string;
  eventType: 'checkout.session.completed' | 'customer.subscription.updated';
  targetTier: PlanTier;
  signature?: string;
}

export interface BillingProvider {
  readonly providerName: 'stripe_compatible' | 'manual_invoice';
  isConfigured(): boolean;
  createCheckoutSession(workspaceId: string, targetTier: PlanTier): Promise<BillingCheckoutSession>;
  verifyWebhookSignature(rawBody: string, signatureHeader?: string): boolean;
}

class StudioBillingProvider implements BillingProvider {
  get providerName(): 'stripe_compatible' | 'manual_invoice' {
    return process.env.STRIPE_SECRET_KEY ? 'stripe_compatible' : 'manual_invoice';
  }

  isConfigured(): boolean {
    return Boolean(process.env.STRIPE_SECRET_KEY);
  }

  async createCheckoutSession(workspaceId: string, targetTier: PlanTier): Promise<BillingCheckoutSession> {
    const id = `chk_${crypto.randomBytes(6).toString('hex')}`;
    const createdAt = new Date().toISOString();

    if (process.env.STRIPE_SECRET_KEY && process.env.BILLING_CHECKOUT_BASE_URL) {
      return {
        id,
        workspaceId,
        targetTier,
        provider: 'stripe_compatible',
        status: 'pending',
        checkoutUrl: `${process.env.BILLING_CHECKOUT_BASE_URL}?workspace=${encodeURIComponent(
          workspaceId
        )}&tier=${encodeURIComponent(targetTier)}&session=${id}`,
        note: 'Checkout URL generated from configured billing provider integration.',
        createdAt,
      };
    }

    return {
      id,
      workspaceId,
      targetTier,
      provider: 'manual_invoice',
      status: 'pending',
      checkoutUrl: null,
      note: 'External Stripe keys (STRIPE_SECRET_KEY) are not configured on localhost. Use the Owner tier selector or configure webhook secrets for automated billing.',
      createdAt,
    };
  }

  verifyWebhookSignature(rawBody: string, signatureHeader?: string): boolean {
    const secret = process.env.BILLING_WEBHOOK_SECRET;
    if (!secret) {
      // Only allow unsigned test webhooks on explicit local dev when no webhook secret is configured
      return process.env.NODE_ENV !== 'production';
    }
    if (!signatureHeader) return false;
    const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
    const a = Buffer.from(signatureHeader, 'utf8');
    const b = Buffer.from(expected, 'utf8');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }
}

export const billingProvider: BillingProvider = new StudioBillingProvider();
