DROP TABLE IF EXISTS `creature_template`;
CREATE TABLE `creature_template` (
  `Entry` mediumint unsigned NOT NULL DEFAULT '0',
  `Name` char(100) NOT NULL DEFAULT '',
  `SubName` char(100) DEFAULT NULL,
  `MinLevel` tinyint unsigned NOT NULL DEFAULT '1',
  `LootId` mediumint unsigned NOT NULL DEFAULT '0',
  `PickpocketLootId` mediumint unsigned NOT NULL DEFAULT '0',
  `SkinningLootId` mediumint unsigned NOT NULL DEFAULT '0',
  PRIMARY KEY (`Entry`)
) ENGINE=MyISAM DEFAULT CHARSET=utf8mb3;
INSERT INTO `creature_template` VALUES (7001,'Fixture Giver','Quest Clerk',5,7001,0,0),(7002,'Fixture Wanderer',NULL,6,7002,7002,7002),(7003,'[UNUSED] Old Fixture',NULL,1,7003,0,0);
INSERT INTO `creature_template` VALUES (7004,'Fixture O\'Brien',NULL,2,9999,0,0),(7005,'Fixture \"Twin\" Smith','',3,0,0,0),(7006,'Fixture Combat Dummy',NULL,1,0,0,0),(7007,'Fixture Trigger',NULL,1,0,0,0),(7008,'Fixture Test Dummy',NULL,1,0,0,0),(7009,'Fixture Warlock (TEST)',NULL,1,0,0,0);
DROP TABLE IF EXISTS `creature`;
CREATE TABLE `creature` (
  `guid` int unsigned NOT NULL AUTO_INCREMENT,
  `id` mediumint unsigned NOT NULL DEFAULT '0',
  `map` smallint unsigned NOT NULL DEFAULT '0',
  `spawnMask` tinyint unsigned NOT NULL DEFAULT '1',
  `position_x` float NOT NULL DEFAULT '0',
  `position_y` float NOT NULL DEFAULT '0',
  `position_z` float NOT NULL DEFAULT '0',
  PRIMARY KEY (`guid`)
) ENGINE=MyISAM DEFAULT CHARSET=utf8mb3;
INSERT INTO `creature` VALUES (1,7001,1,1,500,500,0),(2,0,1,1,-500,-500,0),(3,7002,1,1,600,600,0),(4,7001,33,1,1,1,0);
DROP TABLE IF EXISTS `creature_spawn_entry`;
CREATE TABLE `creature_spawn_entry` (
  `guid` int unsigned NOT NULL DEFAULT '0',
  `entry` mediumint unsigned NOT NULL DEFAULT '0'
) ENGINE=MyISAM DEFAULT CHARSET=utf8mb3;
INSERT INTO `creature_spawn_entry` VALUES (2,7002),(2,7004);
DROP TABLE IF EXISTS `game_event_creature`;
CREATE TABLE `game_event_creature` (
  `guid` int unsigned NOT NULL,
  `event` smallint NOT NULL DEFAULT '0'
) ENGINE=MyISAM DEFAULT CHARSET=utf8mb3;
INSERT INTO `game_event_creature` VALUES (3,5),(1,-2);
DROP TABLE IF EXISTS `game_event_creature_data`;
CREATE TABLE `game_event_creature_data` (
  `guid` int unsigned NOT NULL DEFAULT '0',
  `entry_id` mediumint unsigned NOT NULL DEFAULT '0',
  `modelid` mediumint unsigned NOT NULL DEFAULT '0',
  `equipment_id` mediumint unsigned NOT NULL DEFAULT '0',
  `spell_start` mediumint unsigned NOT NULL DEFAULT '0',
  `spell_end` mediumint unsigned NOT NULL DEFAULT '0',
  `event` smallint unsigned NOT NULL DEFAULT '0'
) ENGINE=MyISAM DEFAULT CHARSET=utf8mb3;
INSERT INTO `game_event_creature_data` VALUES (1,7005,0,0,0,0,7),(1,7005,0,0,0,0,8),(1,7001,0,0,0,0,9);
DROP TABLE IF EXISTS `quest_template`;
CREATE TABLE `quest_template` (
  `entry` mediumint unsigned NOT NULL DEFAULT '0',
  `MinLevel` tinyint unsigned NOT NULL DEFAULT '0',
  `Title` text,
  `Objectives` text
) ENGINE=MyISAM DEFAULT CHARSET=utf8mb3;
INSERT INTO `quest_template` VALUES (111,1,'Fixture Errand','Do it, then come back.'),(222,1,'Fixture Errand','The other side\'s errand.'),(333,1,'<UNUSED> Fixture',NULL);
DROP TABLE IF EXISTS `creature_questrelation`;
CREATE TABLE `creature_questrelation` (
  `id` mediumint unsigned NOT NULL DEFAULT '0',
  `quest` mediumint unsigned NOT NULL DEFAULT '0'
) ENGINE=MyISAM DEFAULT CHARSET=utf8mb3;
INSERT INTO `creature_questrelation` VALUES (7001,111),(7003,333),(7002,222);
DROP TABLE IF EXISTS `creature_involvedrelation`;
CREATE TABLE `creature_involvedrelation` (
  `id` mediumint unsigned NOT NULL DEFAULT '0',
  `quest` mediumint unsigned NOT NULL DEFAULT '0'
) ENGINE=MyISAM DEFAULT CHARSET=utf8mb3;
INSERT INTO `creature_involvedrelation` VALUES (7001,111);
DROP TABLE IF EXISTS `gameobject_template`;
CREATE TABLE `gameobject_template` (
  `entry` mediumint unsigned NOT NULL DEFAULT '0',
  `type` tinyint unsigned NOT NULL DEFAULT '0',
  `name` varchar(100) NOT NULL DEFAULT '',
  `data1` int unsigned NOT NULL DEFAULT '0'
) ENGINE=MyISAM DEFAULT CHARSET=utf8mb3;
INSERT INTO `gameobject_template` VALUES (8001,2,'Fixture Poster',8100),(8002,3,'Fixture Rock',0),(8003,3,'Cache of the Firelord',8100),(8004,25,'Fixture School',8101),(8005,3,'Fixture Lockbox',9998),(8006,3,'Cache of the Firelord',8100);
DROP TABLE IF EXISTS `gameobject`;
CREATE TABLE `gameobject` (
  `guid` int unsigned NOT NULL AUTO_INCREMENT,
  `id` mediumint unsigned NOT NULL DEFAULT '0',
  `map` smallint unsigned NOT NULL DEFAULT '0',
  `spawnMask` tinyint unsigned NOT NULL DEFAULT '1',
  `position_x` float NOT NULL DEFAULT '0',
  `position_y` float NOT NULL DEFAULT '0'
) ENGINE=MyISAM DEFAULT CHARSET=utf8mb3;
INSERT INTO `gameobject` VALUES (10,8001,1,1,100,100),(11,8002,1,1,1,1),(12,8001,33,1,5,5),(13,8003,409,1,1,1),(14,8004,1,1,100,100),(15,8006,1,1,100,100);
DROP TABLE IF EXISTS `game_event_gameobject`;
CREATE TABLE `game_event_gameobject` (
  `guid` int unsigned NOT NULL,
  `event` smallint NOT NULL DEFAULT '0'
) ENGINE=MyISAM DEFAULT CHARSET=utf8mb3;
DROP TABLE IF EXISTS `gameobject_questrelation`;
CREATE TABLE `gameobject_questrelation` (
  `id` mediumint unsigned NOT NULL DEFAULT '0',
  `quest` mediumint unsigned NOT NULL DEFAULT '0'
) ENGINE=MyISAM DEFAULT CHARSET=utf8mb3;
INSERT INTO `gameobject_questrelation` VALUES (8001,222);
DROP TABLE IF EXISTS `gameobject_involvedrelation`;
CREATE TABLE `gameobject_involvedrelation` (
  `id` mediumint unsigned NOT NULL DEFAULT '0',
  `quest` mediumint unsigned NOT NULL DEFAULT '0'
) ENGINE=MyISAM DEFAULT CHARSET=utf8mb3;
DROP TABLE IF EXISTS `conditions`;
CREATE TABLE `conditions` (
  `condition_entry` mediumint unsigned NOT NULL DEFAULT '0',
  `type` tinyint NOT NULL DEFAULT '0',
  `value1` mediumint unsigned NOT NULL DEFAULT '0'
) ENGINE=MyISAM DEFAULT CHARSET=utf8mb3;
INSERT INTO `conditions` VALUES (5,8,111);
DROP TABLE IF EXISTS `item_template`;
CREATE TABLE `item_template` (
  `entry` mediumint unsigned NOT NULL DEFAULT '0',
  `name` varchar(255) NOT NULL DEFAULT '',
  `Flags` int unsigned NOT NULL DEFAULT '0',
  `DisenchantID` mediumint unsigned NOT NULL DEFAULT '0',
  `maxMoneyLoot` int unsigned NOT NULL DEFAULT '0'
) ENGINE=MyISAM DEFAULT CHARSET=utf8mb3;
INSERT INTO `item_template` VALUES (511,'Era Fixture Hide (1.12)',4,0,0),(512,'Era Fixture Cap',4,61,10),(513,'Schematic: The Era Fixture',0,0,0),(514,'Recipe: Era Blast',4,0,0),(600,'Fixture Item The Client Lacks',0,0,0),(601,'Fixture Bag The Client Lacks',4,0,0);
DROP TABLE IF EXISTS `creature_loot_template`;
CREATE TABLE `creature_loot_template` (
  `entry` mediumint unsigned NOT NULL DEFAULT '0',
  `item` mediumint unsigned NOT NULL DEFAULT '0',
  `ChanceOrQuestChance` float NOT NULL DEFAULT '100',
  `groupid` tinyint unsigned NOT NULL DEFAULT '0',
  `mincountOrRef` mediumint NOT NULL DEFAULT '1',
  `maxcount` tinyint unsigned NOT NULL DEFAULT '1',
  `condition_id` mediumint unsigned NOT NULL DEFAULT '0',
  `comments` varchar(300) DEFAULT '',
  PRIMARY KEY (`entry`,`item`)
) ENGINE=MyISAM DEFAULT CHARSET=utf8mb3;
INSERT INTO `creature_loot_template` VALUES (7001,512,50,0,1,1,0,'direct'),(7001,513,-100,0,1,1,5,'quest only and conditional'),(7001,700,5,0,-700,1,0,'reference'),(7001,702,5,0,-702,1,0,'second reference'),(7002,512,0,1,1,1,0,'equal chance in a group'),(7002,701,10,0,-701,1,5,'conditional reference'),(7002,600,10,0,1,1,0,'not in the client'),(7002,998,10,0,1,1,0,'not in item_template'),(7002,513,0,0,1,1,0,'zero chance outside a group'),(7002,511,10,0,1,1,77,'missing condition'),(7002,703,10,0,-703,0,0,'never rolled'),(7002,704,10,0,-704,1,0,'missing reference'),(7002,705,-10,0,-705,1,0,'negative chance on a reference'),(7003,512,10,0,1,1,0,'junk owner'),(7003,511,10,0,1,1,0,'second row of an unreferenced template');
DROP TABLE IF EXISTS `reference_loot_template`;
CREATE TABLE `reference_loot_template` (
  `entry` mediumint unsigned NOT NULL DEFAULT '0',
  `item` mediumint unsigned NOT NULL DEFAULT '0',
  `ChanceOrQuestChance` float NOT NULL DEFAULT '100',
  `groupid` tinyint unsigned NOT NULL DEFAULT '0',
  `mincountOrRef` mediumint NOT NULL DEFAULT '1',
  `maxcount` tinyint unsigned NOT NULL DEFAULT '1',
  `condition_id` mediumint unsigned NOT NULL DEFAULT '0',
  `comments` varchar(300) DEFAULT '',
  PRIMARY KEY (`entry`,`item`)
) ENGINE=MyISAM DEFAULT CHARSET=utf8mb3;
INSERT INTO `reference_loot_template` VALUES (700,514,1,0,1,1,5,'conditional item'),(700,511,1,0,1,1,0,'item'),(700,512,1,0,1,1,0,'also a direct drop'),(701,702,100,0,-702,1,0,'nested reference'),(702,514,1,0,1,1,0,'item'),(703,512,1,0,1,1,0,'only behind a row that never rolls'),(705,512,1,0,1,1,0,'unreferenced');
DROP TABLE IF EXISTS `skinning_loot_template`;
CREATE TABLE `skinning_loot_template` (
  `entry` mediumint unsigned NOT NULL DEFAULT '0',
  `item` mediumint unsigned NOT NULL DEFAULT '0',
  `ChanceOrQuestChance` float NOT NULL DEFAULT '100',
  `groupid` tinyint unsigned NOT NULL DEFAULT '0',
  `mincountOrRef` mediumint NOT NULL DEFAULT '1',
  `maxcount` tinyint unsigned NOT NULL DEFAULT '1',
  `condition_id` mediumint unsigned NOT NULL DEFAULT '0',
  `comments` varchar(300) DEFAULT '',
  PRIMARY KEY (`entry`,`item`)
) ENGINE=MyISAM DEFAULT CHARSET=utf8mb3;
INSERT INTO `skinning_loot_template` VALUES (7002,511,100,0,1,2,0,''),(7002,512,100,5,1,1,5,'conditional, so group 5 is not always filled'),(7002,513,0,5,1,1,0,'reached when the condition fails');
DROP TABLE IF EXISTS `pickpocketing_loot_template`;
CREATE TABLE `pickpocketing_loot_template` (
  `entry` mediumint unsigned NOT NULL DEFAULT '0',
  `item` mediumint unsigned NOT NULL DEFAULT '0',
  `ChanceOrQuestChance` float NOT NULL DEFAULT '100',
  `groupid` tinyint unsigned NOT NULL DEFAULT '0',
  `mincountOrRef` mediumint NOT NULL DEFAULT '1',
  `maxcount` tinyint unsigned NOT NULL DEFAULT '1',
  `condition_id` mediumint unsigned NOT NULL DEFAULT '0',
  `comments` varchar(300) DEFAULT '',
  PRIMARY KEY (`entry`,`item`)
) ENGINE=MyISAM DEFAULT CHARSET=utf8mb3;
INSERT INTO `pickpocketing_loot_template` VALUES (7002,512,30,0,1,1,0,''),(7002,513,-100,4,1,1,0,'a quest row always fills group 4'),(7002,514,0,4,1,1,0,'never reached in group 4'),(7002,600,100,6,1,1,0,'a row the client lacks still fills group 6'),(7002,511,0,6,1,1,0,'never reached in group 6'),(7002,705,100,7,-705,0,0,'a zero-count reference still fills group 7'),(7002,511,0,7,1,1,0,'never reached in group 7');
DROP TABLE IF EXISTS `gameobject_loot_template`;
CREATE TABLE `gameobject_loot_template` (
  `entry` mediumint unsigned NOT NULL DEFAULT '0',
  `item` mediumint unsigned NOT NULL DEFAULT '0',
  `ChanceOrQuestChance` float NOT NULL DEFAULT '100',
  `groupid` tinyint unsigned NOT NULL DEFAULT '0',
  `mincountOrRef` mediumint NOT NULL DEFAULT '1',
  `maxcount` tinyint unsigned NOT NULL DEFAULT '1',
  `condition_id` mediumint unsigned NOT NULL DEFAULT '0',
  `comments` varchar(300) DEFAULT '',
  PRIMARY KEY (`entry`,`item`)
) ENGINE=MyISAM DEFAULT CHARSET=utf8mb3;
INSERT INTO `gameobject_loot_template` VALUES (8100,512,100,0,1,1,0,''),(8101,514,100,0,1,1,0,'');
DROP TABLE IF EXISTS `fishing_loot_template`;
CREATE TABLE `fishing_loot_template` (
  `entry` mediumint unsigned NOT NULL DEFAULT '0',
  `item` mediumint unsigned NOT NULL DEFAULT '0',
  `ChanceOrQuestChance` float NOT NULL DEFAULT '100',
  `groupid` tinyint unsigned NOT NULL DEFAULT '0',
  `mincountOrRef` mediumint NOT NULL DEFAULT '1',
  `maxcount` tinyint unsigned NOT NULL DEFAULT '1',
  `condition_id` mediumint unsigned NOT NULL DEFAULT '0',
  `comments` varchar(300) DEFAULT '',
  PRIMARY KEY (`entry`,`item`)
) ENGINE=MyISAM DEFAULT CHARSET=utf8mb3;
INSERT INTO `fishing_loot_template` VALUES (7101,511,100,0,1,1,0,''),(9090,512,100,0,1,1,0,'');
DROP TABLE IF EXISTS `item_loot_template`;
CREATE TABLE `item_loot_template` (
  `entry` mediumint unsigned NOT NULL DEFAULT '0',
  `item` mediumint unsigned NOT NULL DEFAULT '0',
  `ChanceOrQuestChance` float NOT NULL DEFAULT '100',
  `groupid` tinyint unsigned NOT NULL DEFAULT '0',
  `mincountOrRef` mediumint NOT NULL DEFAULT '1',
  `maxcount` tinyint unsigned NOT NULL DEFAULT '1',
  `condition_id` mediumint unsigned NOT NULL DEFAULT '0',
  `comments` varchar(300) DEFAULT '',
  PRIMARY KEY (`entry`,`item`)
) ENGINE=MyISAM DEFAULT CHARSET=utf8mb3;
INSERT INTO `item_loot_template` VALUES (513,512,100,0,1,1,0,'no has-loot flag'),(514,512,100,0,1,1,0,''),(601,512,100,0,1,1,0,'not in the client');
DROP TABLE IF EXISTS `disenchant_loot_template`;
CREATE TABLE `disenchant_loot_template` (
  `entry` mediumint unsigned NOT NULL DEFAULT '0',
  `item` mediumint unsigned NOT NULL DEFAULT '0',
  `ChanceOrQuestChance` float NOT NULL DEFAULT '100',
  `groupid` tinyint unsigned NOT NULL DEFAULT '0',
  `mincountOrRef` mediumint NOT NULL DEFAULT '1',
  `maxcount` tinyint unsigned NOT NULL DEFAULT '1',
  `condition_id` mediumint unsigned NOT NULL DEFAULT '0',
  `comments` varchar(300) DEFAULT '',
  PRIMARY KEY (`entry`,`item`)
) ENGINE=MyISAM DEFAULT CHARSET=utf8mb3;
INSERT INTO `disenchant_loot_template` VALUES (61,511,100,0,1,1,0,''),(62,512,100,0,1,1,0,'');
