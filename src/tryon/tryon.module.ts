import { MikroOrmModule } from '@mikro-orm/nestjs';
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { Garment } from '../dal/entity/garment.entity';
import { TryOnJob } from '../dal/entity/try-on-job.entity';
import { FileModule } from '../file/file.module';
import { NotificationModule } from '../notification/notification.module';
import { WardrobeModule } from '../wardrobe/wardrobe.module';
import { TryOnController } from './tryon.controller';
import { TryOnInstallerService } from './tryon-installer.service';
import { TryOnSettingsService } from './tryon-settings.service';
import { TryOnService } from './tryon.service';

@Module({
  imports: [
    AuthModule,
    FileModule,
    NotificationModule,
    WardrobeModule,
    MikroOrmModule.forFeature([TryOnJob, Garment]),
  ],
  controllers: [TryOnController],
  providers: [TryOnSettingsService, TryOnInstallerService, TryOnService],
})
export class TryOnModule {}
