import { MikroOrmModule } from '@mikro-orm/nestjs';
import { Module } from '@nestjs/common';
import { Garment } from '../dal/entity/garment.entity';
import { Outfit } from '../dal/entity/outfit.entity';
import { OutfitCalendar } from '../dal/entity/outfit-calendar.entity';
import { User } from '../dal/entity/user.entity';
import { FileModule } from '../file/file.module';
import { AuthModule } from '../auth/auth.module';
import { WardrobeShareModule } from '../wardrobe-share/wardrobe-share.module';
import { GarmentService } from './garment.service';
import { OutfitService } from './outfit.service';
import { CalendarService } from './calendar.service';
import { CalendarController } from './calendar.controller';
import { WardrobeController } from './wardrobe.controller';
import { OutfitController } from './outfit.controller';
import { WeatherModule } from '../weather/weather.module';
import { WearStatsService } from './wear-stats.service';
import { LaundryController } from './laundry.controller';
import { StatsController } from './stats.controller';
import { BackupService } from './backup.service';
import { BackupController } from './backup.controller';

@Module({
  imports: [
    AuthModule,
    FileModule,
    WardrobeShareModule,
    MikroOrmModule.forFeature([Garment, Outfit, OutfitCalendar, User]),
    WeatherModule,
  ],
  controllers: [
    WardrobeController,
    OutfitController,
    CalendarController,
    LaundryController,
    StatsController,
    BackupController,
  ],
  providers: [
    GarmentService,
    OutfitService,
    CalendarService,
    WearStatsService,
    BackupService,
  ],
  exports: [GarmentService, OutfitService, CalendarService, WearStatsService],
})
export class WardrobeModule {}
