import { Body, Controller, Get, Header, Post, Render, HttpException } from '@nestjs/common';
import { SubscriptionManagementService } from './subscription-management.service';
import { CancelSubscriptionDto } from './dto/cancel-subscription.dto';

@Controller('subscription')
export class SubscriptionManagementController {
  constructor(
    private readonly subscriptionManagementService: SubscriptionManagementService,
  ) {}

  @Get('cancel')
  @Header('Content-Type', 'text/html')
  @Render('subscription/cancel')
  showCancellationForm() {
    return {
      status: null,
      message: null,
      form: {},
    };
  }

  @Get('terms')
  @Header('Content-Type', 'text/html')
  @Render('subscription/terms')
  showTermsPage() {
    return {
      cancellationLink: this.subscriptionManagementService.getCancellationLink(),
    };
  }

  @Post('cancel')
  @Header('Content-Type', 'text/html')
  @Render('subscription/cancel')
  async handleCancellation(@Body() body: CancelSubscriptionDto) {
    try {
      const result =
        await this.subscriptionManagementService.cancelSubscription(body);
      return {
        status: 'success',
        message: result.message,
        form: {},
      };
    } catch (error) {
      let message = 'Nomaʼlum xatolik yuz berdi. Keyinroq urinib ko‘ring.';

      if (error instanceof HttpException) {
        const response = error.getResponse();
        if (typeof response === 'string') {
          message = response;
        } else if (
          typeof response === 'object' &&
          response &&
          'message' in response
        ) {
          const detailed = Array.isArray(response['message'])
            ? response['message'][0]
            : response['message'];
          message = detailed ?? message;
        }
      }

      return {
        status: 'error',
        message,
        form: {
          telegramId: body.telegramId,
        },
      };
    }
  }
}
